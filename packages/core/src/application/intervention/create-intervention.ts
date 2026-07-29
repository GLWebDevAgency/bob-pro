import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appConflict, appDomain, appNotFound } from '../result';
import { type Instant } from '../../shared-kernel/time';
import { Intervention, type ChecklistItem } from '../../domain/intervention/intervention';
import { type ChantierRepository } from '../ports/repositories';
import { type CustomerRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import {
  type InterventionRepository,
  type CompanyInterventionSettingsRepository,
  checklistTemplateForKind,
} from './intervention-repository';

/** [Revue A12] — refus ACTIONNABLE unique du site clôturé (écran ET voix). */
export const CHANTIER_CLOSED_INTERVENTION_MESSAGE =
  'Ce site est clôturé — rouvre-le pour créer un passage.';

/** [Revue P15] — 409 GÉNÉRIQUE : jamais un oracle d'existence inter-tenant. */
export const INTERVENTION_ID_COLLISION_MESSAGE =
  'Identifiant de fiche déjà utilisé — régénère un identifiant et rejoue.';

/** uuid v4 STRICT (§3.2 [P15]) — seule forme admise pour un id fourni par le client. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CreateInterventionInput {
  companyId: string;
  /**
   * Id GÉNÉRÉ CÔTÉ CLIENT (offline-first §3.6, rejouable) — uuid v4 STRICTEMENT validé.
   * Absent (création en ligne, voix) : le serveur génère via IdGeneratorPort.
   */
  id?: string;
  chantierId: string;
  customerId: string;
  equipmentId?: string | null;
  /** Libellé LIBRE requis (« Visite contractuelle », « Dépannage ») — jamais une machine. */
  kind: string;
  plannedAt?: Instant | null;
  technicianLabel?: string | null;
  /** Absent : pré-rempli par le template société du `kind` (reste LIBRE, §3.4). */
  checklist?: ChecklistItem[];
}

export interface CreateInterventionDeps {
  interventions: InterventionRepository;
  chantiers: ChantierRepository;
  customers: Pick<CustomerRepository, 'findById'>;
  ids: IdGeneratorPort;
  clock: ClockPort;
  /** REQUIS dès qu'un `equipmentId` est fourni (fail-closed, patron chantierTargets). */
  equipments?: EquipmentRepository;
  /** Optionnel — pré-remplissage de checklist par template société (jamais bloquant). */
  interventionSettings?: CompanyInterventionSettingsRepository;
}

/**
 * Bloc C §3.5 — création d'une fiche de passage : site PROUVÉ dans le tenant ET `open`,
 * client du tenant, équipement du MÊME site (fail-closed). `contractId` n'est JAMAIS accepté
 * ici : le lien contractuel appartient à PlanContractVisits (train Contrats) — aucun lien
 * non vérifié. Écran ET voix passent par CE use case (parité).
 */
export class CreateIntervention {
  constructor(private readonly deps: CreateInterventionDeps) {}

  async execute(input: CreateInterventionInput): Promise<Result<{ id: string }, AppError>> {
    let id: string;
    if (input.id !== undefined) {
      const candidate = input.id.trim().toLowerCase();
      if (!UUID_V4.test(candidate))
        return err(
          appDomain({
            code: 'VALIDATION',
            field: 'id',
            message: 'Identifiant de fiche invalide (uuid v4 attendu).',
          }),
        );
      id = candidate;
    } else {
      id = this.deps.ids.newId();
    }

    const chantier = await this.deps.chantiers.findById(input.chantierId);
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', input.chantierId));
    if (chantier.status !== 'open')
      return err(
        appDomain({
          code: 'VALIDATION',
          field: 'chantierId',
          message: CHANTIER_CLOSED_INTERVENTION_MESSAGE,
        }),
      );

    const customer = await this.deps.customers.findById(input.customerId);
    if (!customer || customer.companyId !== input.companyId)
      return err(appNotFound('customer', input.customerId));

    // Équipement du MÊME site, prouvé avant toute persistance (fail-closed, patron PR-11).
    const equipmentId = input.equipmentId?.trim() || null;
    if (equipmentId !== null) {
      if (!this.deps.equipments) {
        return err({
          kind: 'dependency',
          port: 'EquipmentRepository',
          cause: 'equipmentId fourni sans port de vérification (equipments) : lien refusé.',
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

    // Checklist : celle du geste, sinon le template société du kind (reste libre, §3.4).
    let checklist = input.checklist;
    if (checklist === undefined && this.deps.interventionSettings) {
      const settings = await this.deps.interventionSettings.find(input.companyId);
      const template = checklistTemplateForKind(settings, input.kind);
      if (template !== null) {
        checklist = template.map((label) => ({ label, done: false }));
      }
    }

    const recorded = Intervention.record({
      id,
      companyId: input.companyId,
      chantierId: input.chantierId,
      customerId: input.customerId,
      contractId: null,
      equipmentId,
      kind: input.kind,
      status: 'scheduled',
      plannedAt: input.plannedAt ?? null,
      technicianLabel: input.technicianLabel ?? null,
      startedAt: null,
      finishedAt: null,
      checklist: checklist ?? [],
      summary: null,
      signature: null,
      reportDocumentId: null,
      billedInvoiceId: null,
      revision: 1,
    });
    if (!recorded.ok) return err(appDomain(recorded.error));

    const created = await this.deps.interventions.create(recorded.value);
    if (created.outcome === 'id_collision') {
      // [Revue P15] 409 GÉNÉRIQUE — ni existence, ni tenant : le client régénère et rejoue.
      return err(appConflict('intervention', 'id_collision'));
    }
    return ok({ id });
  }
}
