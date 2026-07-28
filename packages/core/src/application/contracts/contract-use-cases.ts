import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type DateOnly } from '../../shared-kernel/time';
import {
  CONTRACT_B2C_REFUSED_MESSAGE,
  MaintenanceContract,
  type ContractLineInput,
  type MaintenanceContractPatch,
  type MaintenanceContractProps,
} from '../../domain/contract/maintenance-contract';
import {
  clampedAnniversary,
  currentPeriodIndex,
} from './derive-contract-schedule';
import { type MaintenanceContractRepository } from './maintenance-contract-repository';
import { type ChantierRepository, type CustomerRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';

/** [Revue A12] — refus ACTIONNABLE unique du site clôturé (même message écran et voix). */
export const CHANTIER_CLOSED_CONTRACT_MESSAGE =
  'Ce site est clôturé — rouvre-le pour y rattacher un contrat.';

export interface ContractGuardDeps {
  customers: CustomerRepository;
  chantiers: ChantierRepository;
  equipments: EquipmentRepository;
}

/** Client PROFESSIONNEL prouvé dans le tenant — b2c refusé (direction 5, LegalHint Chatel). */
async function assertProfessionalCustomer(
  deps: Pick<ContractGuardDeps, 'customers'>,
  companyId: string,
  customerId: string,
): Promise<AppError | null> {
  const customer = await deps.customers.findById(customerId);
  if (!customer || customer.companyId !== companyId) return appNotFound('customer', customerId);
  if (customer.type === 'b2c')
    return appDomain({ code: 'VALIDATION', field: 'customerId', message: CONTRACT_B2C_REFUSED_MESSAGE });
  return null;
}

/** Site PROUVÉ dans le tenant et OUVERT (fail-closed, refus actionnable sinon). */
async function assertOpenChantier(
  deps: Pick<ContractGuardDeps, 'chantiers'>,
  companyId: string,
  chantierId: string,
): Promise<AppError | null> {
  const chantier = await deps.chantiers.findById(chantierId);
  if (!chantier || chantier.companyId !== companyId) return appNotFound('chantier', chantierId);
  if (chantier.status !== 'open')
    return appDomain({ code: 'VALIDATION', field: 'chantierId', message: CHANTIER_CLOSED_CONTRACT_MESSAGE });
  return null;
}

/** [§2.6] Chaque équipement lié appartient au tenant ET au SITE du contrat — fail-closed. */
async function assertEquipmentsOfSite(
  deps: Pick<ContractGuardDeps, 'equipments'>,
  companyId: string,
  chantierId: string | null,
  equipmentIds: readonly string[],
): Promise<AppError | null> {
  if (equipmentIds.length === 0) return null;
  if (chantierId === null)
    return appDomain({
      code: 'VALIDATION',
      field: 'equipmentIds',
      message: 'Lie d’abord un site au contrat pour couvrir ses équipements.',
    });
  for (const equipmentId of equipmentIds) {
    const equipment = await deps.equipments.findById(companyId, equipmentId);
    if (!equipment || equipment.companyId !== companyId)
      return appNotFound('equipment', equipmentId);
    if (equipment.chantierId !== chantierId)
      return appDomain({
        code: 'VALIDATION',
        field: 'equipmentIds',
        message: `L’équipement « ${equipment.label} » n’appartient pas au site de ce contrat.`,
      });
  }
  return null;
}

export interface CreateMaintenanceContractInput {
  companyId: string;
  customerId: string;
  label: string;
  chantierId?: string | null;
  anniversaryDate: DateOnly;
  noticeDays?: number;
  visitsPerYear?: number;
  tacitRenewal?: boolean;
  /** [P13] borne EXCLUSIVE — la saisie humaine INCLUSIVE est convertie +1 jour PAR LE CLIENT
   * (wizard, annexe erratum n° 4) avant d'atteindre ce use case. */
  importCoveredUntil?: DateOnly | null;
  notes?: string | null;
  lines?: readonly ContractLineInput[];
  equipmentIds?: readonly string[];
}

export interface CreateMaintenanceContractDeps extends ContractGuardDeps {
  contracts: MaintenanceContractRepository;
  ids: IdGeneratorPort;
}

/**
 * §2.6 — création d'un BROUILLON de contrat : b2c refusé (LegalHint Chatel), site `open`
 * exigé s'il est lié, équipements du MÊME site fail-closed, `importCoveredUntil` déclarable.
 * L'activation est un GESTE DISTINCT (jamais fusionné silencieusement — conception vocale §2.7).
 */
export class CreateMaintenanceContract {
  constructor(private readonly deps: CreateMaintenanceContractDeps) {}

  async execute(
    input: CreateMaintenanceContractInput,
  ): Promise<Result<{ id: string }, AppError>> {
    const customerError = await assertProfessionalCustomer(this.deps, input.companyId, input.customerId);
    if (customerError) return err(customerError);
    const chantierId = input.chantierId ?? null;
    if (chantierId !== null) {
      const chantierError = await assertOpenChantier(this.deps, input.companyId, chantierId);
      if (chantierError) return err(chantierError);
    }
    const equipmentIds = [...(input.equipmentIds ?? [])];
    const equipmentError = await assertEquipmentsOfSite(
      this.deps,
      input.companyId,
      chantierId,
      equipmentIds,
    );
    if (equipmentError) return err(equipmentError);

    const id = this.deps.ids.newId();
    const props: MaintenanceContractProps = {
      id,
      companyId: input.companyId,
      customerId: input.customerId,
      chantierId,
      label: input.label,
      status: 'draft',
      anniversaryDate: input.anniversaryDate,
      noticeDays: input.noticeDays ?? 30,
      visitsPerYear: input.visitsPerYear ?? 2,
      tacitRenewal: input.tacitRenewal ?? true,
      importCoveredUntil: input.importCoveredUntil ?? null,
      activatedAt: null,
      terminatedAt: null,
      terminationEffectiveDate: null,
      terminationNote: null,
      notes: input.notes ?? null,
      revision: 1,
      lines: (input.lines ?? []).map((line, position) => ({
        id: this.deps.ids.newId(),
        catalogueItemId: line.catalogueItemId ?? null,
        label: line.label,
        quantity: line.quantity,
        unitPriceHtCents: line.unitPriceHtCents,
        vatRate: line.vatRate,
        position,
      })),
      equipmentIds,
    };
    const recorded = MaintenanceContract.record(props);
    if (!recorded.ok) return err(appDomain(recorded.error));
    await this.deps.contracts.save(recorded.value);
    return ok({ id });
  }
}

export interface UpdateMaintenanceContractInput {
  companyId: string;
  contractId: string;
  expectedRevision: number;
  patch?: MaintenanceContractPatch;
  lines?: readonly ContractLineInput[];
  equipmentIds?: readonly string[];
}

export interface UpdateMaintenanceContractDeps extends ContractGuardDeps {
  contracts: MaintenanceContractRepository;
  ids: IdGeneratorPort;
}

/** §2.6 — mutation CAS : conditions, lignes et liaison équipements (chacune optionnelle).
 * `anniversaryDate`/`importCoveredUntil`/site figés après activation (garde DOMAINE). */
export class UpdateMaintenanceContract {
  constructor(private readonly deps: UpdateMaintenanceContractDeps) {}

  async execute(
    input: UpdateMaintenanceContractInput,
  ): Promise<Result<MaintenanceContractProps, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.contracts.lockById?.bind(this.deps.contracts)
      ?? this.deps.contracts.findById.bind(this.deps.contracts);
    const contract = await load(input.companyId, input.contractId);
    if (!contract || contract.companyId !== input.companyId)
      return err(appNotFound('maintenance_contract', input.contractId));
    if (contract.revision !== input.expectedRevision)
      return err(appConflict('maintenance_contract', 'stale_revision'));

    if (input.patch !== undefined) {
      const nextChantier =
        input.patch.chantierId !== undefined ? input.patch.chantierId : contract.chantierId;
      if (
        input.patch.chantierId !== undefined
        && input.patch.chantierId !== null
        && input.patch.chantierId !== contract.chantierId
      ) {
        const chantierError = await assertOpenChantier(this.deps, input.companyId, input.patch.chantierId);
        if (chantierError) return err(chantierError);
      }
      // Changement de site en brouillon : la liaison existante doit rester cohérente.
      const futureEquipments = input.equipmentIds ?? contract.equipmentIds;
      const equipmentError = await assertEquipmentsOfSite(
        this.deps,
        input.companyId,
        nextChantier,
        futureEquipments,
      );
      if (equipmentError) return err(equipmentError);
      const updated = contract.update(input.patch);
      if (!updated.ok) return err(appDomain(updated.error));
    }
    if (input.lines !== undefined) {
      const replaced = contract.replaceLines(input.lines, () => this.deps.ids.newId());
      if (!replaced.ok) return err(appDomain(replaced.error));
    }
    if (input.equipmentIds !== undefined) {
      const equipmentError = await assertEquipmentsOfSite(
        this.deps,
        input.companyId,
        contract.chantierId,
        input.equipmentIds,
      );
      if (equipmentError) return err(equipmentError);
      const replaced = contract.replaceEquipments(input.equipmentIds);
      if (!replaced.ok) return err(appDomain(replaced.error));
    }
    if (input.patch === undefined && input.lines === undefined && input.equipmentIds === undefined)
      return err(appDomain({ code: 'VALIDATION', field: 'patch', message: 'Aucune modification fournie.' }));
    await this.deps.contracts.save(contract);
    return ok(contract.toProps());
  }
}

export interface ActivateContractInput {
  companyId: string;
  contractId: string;
  expectedRevision: number;
}

export interface ActivateContractDeps {
  contracts: MaintenanceContractRepository;
  customers: CustomerRepository;
  clock: ClockPort;
}

/** §2.6 — activation : REVALIDE b2b/b2g sur la fiche RELUE (un client passé b2c entre-temps
 * re-reçoit le refus Chatel), FIGE anniversaryDate/importCoveredUntil, pose activatedAt. */
export class ActivateContract {
  constructor(private readonly deps: ActivateContractDeps) {}

  async execute(input: ActivateContractInput): Promise<Result<MaintenanceContractProps, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.contracts.lockById?.bind(this.deps.contracts)
      ?? this.deps.contracts.findById.bind(this.deps.contracts);
    const contract = await load(input.companyId, input.contractId);
    if (!contract || contract.companyId !== input.companyId)
      return err(appNotFound('maintenance_contract', input.contractId));
    if (contract.revision !== input.expectedRevision)
      return err(appConflict('maintenance_contract', 'stale_revision'));
    const customer = await this.deps.customers.findById(contract.customerId);
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', contract.customerId));
    const activated = contract.activate(this.deps.clock.now(), customer.type);
    if (!activated.ok) return err(appDomain(activated.error));
    await this.deps.contracts.save(contract);
    return ok(contract.toProps());
  }
}

export interface TerminateContractInput {
  companyId: string;
  contractId: string;
  expectedRevision: number;
  /** Absente → défaut : PROCHAIN anniversaire CALCULÉ (jamais un floor, §2.5). */
  effectiveDate?: DateOnly | null;
  note: string;
}

export interface TerminateContractDeps {
  contracts: MaintenanceContractRepository;
  clock: ClockPort;
}

/** Prochain anniversaire STRICTEMENT futur — défaut de la date d'effet de résiliation. */
export function nextComputedAnniversary(anniversaryDate: DateOnly, today: DateOnly): DateOnly {
  const index = currentPeriodIndex(anniversaryDate, today);
  const candidate = clampedAnniversary(anniversaryDate, index);
  return candidate > today ? candidate : clampedAnniversary(anniversaryDate, index + 1);
}

/** §2.6 — résiliation TOUJOURS possible depuis `active` (préavis AFFICHÉ, jamais bloquant). */
export class TerminateContract {
  constructor(private readonly deps: TerminateContractDeps) {}

  async execute(input: TerminateContractInput): Promise<Result<MaintenanceContractProps, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.contracts.lockById?.bind(this.deps.contracts)
      ?? this.deps.contracts.findById.bind(this.deps.contracts);
    const contract = await load(input.companyId, input.contractId);
    if (!contract || contract.companyId !== input.companyId)
      return err(appNotFound('maintenance_contract', input.contractId));
    if (contract.revision !== input.expectedRevision)
      return err(appConflict('maintenance_contract', 'stale_revision'));
    const now = this.deps.clock.now();
    const today = now.slice(0, 10);
    const effectiveDate =
      input.effectiveDate ?? nextComputedAnniversary(contract.anniversaryDate, today);
    const terminated = contract.terminate({ decidedAt: now, effectiveDate, note: input.note });
    if (!terminated.ok) return err(appDomain(terminated.error));
    await this.deps.contracts.save(contract);
    return ok(contract.toProps());
  }
}

export interface DeleteDraftContractInput {
  companyId: string;
  contractId: string;
  expectedRevision: number;
}

export interface DeleteDraftContractDeps {
  contracts: MaintenanceContractRepository;
}

/** §2.4 — suppression d'un BROUILLON uniquement (trigger SQL BEFORE DELETE draft-only en
 * défense en profondeur : le grant ne suffit jamais seul, amélioration 1). */
export class DeleteDraftContract {
  constructor(private readonly deps: DeleteDraftContractDeps) {}

  async execute(input: DeleteDraftContractInput): Promise<Result<{ deleted: true }, AppError>> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      return err(appDomain({ code: 'VALIDATION', field: 'expectedRevision', message: 'Révision invalide.' }));
    const load = this.deps.contracts.lockById?.bind(this.deps.contracts)
      ?? this.deps.contracts.findById.bind(this.deps.contracts);
    const contract = await load(input.companyId, input.contractId);
    if (!contract || contract.companyId !== input.companyId)
      return err(appNotFound('maintenance_contract', input.contractId));
    if (contract.revision !== input.expectedRevision)
      return err(appConflict('maintenance_contract', 'stale_revision'));
    if (contract.status !== 'draft')
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'status',
          message: 'Seul un brouillon se supprime — un contrat vivant se résilie (trace).',
        }),
      );
    await this.deps.contracts.deleteById(input.companyId, input.contractId);
    return ok({ deleted: true });
  }
}
