import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ChantierRepository, type ChantierNoteRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type InterventionRepository } from '../intervention/intervention-repository';
import { INTERVENTION_SIGNED_LOCKED_MESSAGE } from '../../domain/intervention/intervention';
import { ChantierNote } from '../../domain/chantier/chantier-note';

export interface AddChantierNoteInput {
  companyId: string;
  chantierId: string;
  text: string;
  authorLabel: string;
  /** PR-11 — équipement du site visé par la note (tag additif) : absent/null = note du site. */
  equipmentId?: string | null;
  /** PR-15 — fiche de passage visée (tag additif) : absent/null = note hors passage. */
  interventionId?: string | null;
}

export interface AddChantierNoteDeps {
  chantiers: ChantierRepository;
  notes: ChantierNoteRepository;
  ids: IdGeneratorPort;
  clock: ClockPort;
  /** PR-11 — REQUIS dès qu'un `equipmentId` est fourni : sans port, le tag est refusé
   * (fail-closed, jamais un lien non vérifié — patron CreateQuote.chantierTargets). */
  equipments?: EquipmentRepository;
  /** PR-15 — REQUIS dès qu'un `interventionId` est fourni (même doctrine fail-closed). */
  interventions?: InterventionRepository;
}

/**
 * Journal d'activité d'un chantier/projet — création manuelle (fiche chantier) ET vocale
 * (« ajoute une note au chantier Lefèvre : … ») : les deux passent par ce MÊME use case.
 */
export class AddChantierNote {
  constructor(private readonly deps: AddChantierNoteDeps) {}

  async execute(input: AddChantierNoteInput): Promise<Result<{ id: string }, AppError>> {
    const chantier = await this.deps.chantiers.findById(input.chantierId);
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', input.chantierId));

    // PR-11 — cohérence équipement↔site PROUVÉE avant toute persistance (fail-closed) ;
    // le trigger SQL equipment_scope_coherence re-vérifie en défense en profondeur.
    const equipmentId = input.equipmentId?.trim() || null;
    if (equipmentId !== null) {
      if (!this.deps.equipments) {
        return err({
          kind: 'dependency',
          port: 'EquipmentRepository',
          cause: 'equipmentId fourni sans port de vérification (equipments) : tag refusé.',
        });
      }
      const equipment = await this.deps.equipments.findById(input.companyId, equipmentId);
      if (!equipment || equipment.companyId !== input.companyId)
        return err(appNotFound('equipment', equipmentId));
      if (equipment.chantierId !== input.chantierId)
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'equipmentId',
            message: 'Cet équipement appartient à un autre site.',
          }),
        );
    }

    // PR-15 — note de PASSAGE : fiche prouvée dans le tenant, sur le MÊME site, encore
    // OUVERTE aux traces (avant `signed`). La séquence erratum 6 vit ICI : la note
    // automatique de résolution (« 1 photo n'a pas pu être jointe ») est ACCEPTÉE sur une
    // fiche `completed`, PUIS la signature passe — après `signed`, refus définitif.
    const interventionId = input.interventionId?.trim() || null;
    if (interventionId !== null) {
      if (!this.deps.interventions) {
        return err({
          kind: 'dependency',
          port: 'InterventionRepository',
          cause: 'interventionId fourni sans port de vérification (interventions) : tag refusé.',
        });
      }
      const intervention = await this.deps.interventions.findById(input.companyId, interventionId);
      if (!intervention || intervention.companyId !== input.companyId)
        return err(appNotFound('intervention', interventionId));
      if (intervention.chantierId !== input.chantierId)
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'interventionId',
            message: 'Cette fiche de passage appartient à un autre site.',
          }),
        );
      if (!intervention.acceptsFieldTraces())
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'interventionId',
            message: INTERVENTION_SIGNED_LOCKED_MESSAGE,
          }),
        );
    }

    const id = this.deps.ids.newId();
    const r = ChantierNote.record({
      id,
      companyId: input.companyId,
      chantierId: input.chantierId,
      text: input.text,
      authorLabel: input.authorLabel,
      createdAt: this.deps.clock.now(),
      equipmentId,
      interventionId,
    });
    if (!r.ok) return err(appDomain(r.error));
    await this.deps.notes.save(r.value);
    return ok({ id });
  }
}
