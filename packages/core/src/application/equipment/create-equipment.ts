import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type DateOnly } from '../../shared-kernel/time';
import { Equipment } from '../../domain/equipment/equipment';
import { type ChantierRepository } from '../ports/repositories';
import { type EquipmentRepository } from './equipment-repository';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';

/**
 * [Revue A12] — refus ACTIONNABLE unique du site clôturé : même message à l'écran et à la
 * voix, toujours accompagné de la proposition de réouverture (ReopenChantier).
 */
export const CHANTIER_CLOSED_EQUIPMENT_MESSAGE =
  'Ce site est clôturé — rouvre-le pour ajouter un équipement.';

export interface CreateEquipmentInput {
  companyId: string;
  chantierId: string;
  label: string;
  kind?: string | null;
  brand?: string | null;
  serialNumber?: string | null;
  location?: string | null;
  installedAt?: DateOnly | null;
  warrantyUntil?: DateOnly | null;
  notes?: string | null;
}

export interface CreateEquipmentDeps {
  equipments: EquipmentRepository;
  chantiers: ChantierRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
}

/**
 * Bloc A §1.5 — création d'un équipement du parc : site PROUVÉ dans le tenant (anti-IDOR
 * fail-closed) ET `open` (refus actionnable + proposition de réouverture sinon).
 * Écran ET voix passent par CE use case (parité).
 */
export class CreateEquipment {
  constructor(private readonly deps: CreateEquipmentDeps) {}

  async execute(input: CreateEquipmentInput): Promise<Result<{ id: string }, AppError>> {
    const chantier = await this.deps.chantiers.findById(input.chantierId);
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', input.chantierId));
    if (chantier.status !== 'open')
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'chantierId',
          message: CHANTIER_CLOSED_EQUIPMENT_MESSAGE,
        }),
      );

    const id = this.deps.ids.newId();
    const recorded = Equipment.record({
      id,
      companyId: input.companyId,
      chantierId: input.chantierId,
      label: input.label,
      kind: input.kind ?? null,
      brand: input.brand ?? null,
      serialNumber: input.serialNumber ?? null,
      location: input.location ?? null,
      installedAt: input.installedAt ?? null,
      warrantyUntil: input.warrantyUntil ?? null,
      status: 'active',
      retiredAt: null,
      notes: input.notes ?? null,
      revision: 1,
    });
    if (!recorded.ok) return err(appDomain(recorded.error));
    await this.deps.equipments.save(recorded.value);
    return ok({ id });
  }
}
