import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ChantierRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
import { type InterventionRepository } from '../intervention/intervention-repository';
import {
  interventionFieldTraceRefusal,
  interventionPhotoPhaseRefusal,
  INTERVENTION_PHOTO_PHASES,
  type InterventionPhotoPhase,
} from '../../domain/intervention/intervention';
import { type WorksiteMediaStorage, type WorksiteMediaItem } from '../ports/worksite-media';
import { type DocumentStoragePort } from '../ports/document-storage';

const MAX_PHOTO_BYTES = 15_000_000; // 15 Mo — confort d'une photo compressée côté app (cf. mobile)

export interface UploadWorksitePhotoInput {
  companyId: string;
  chantierId: string;
  bytes: Uint8Array;
  contentType: string;
  filename: string;
  /** PR-11 — équipement du site visé par la photo (tag additif) : absent/null = photo du site. */
  equipmentId?: string | null;
  /** PR-15 — fiche de passage visée (tag additif) : absent/null = photo hors passage. */
  interventionId?: string | null;
  /** PR-15 — phase avant/après : exige `interventionId` (fail-closed). */
  phase?: InterventionPhotoPhase | null;
}

export interface UploadWorksitePhotoDeps {
  chantiers: ChantierRepository;
  media: WorksiteMediaStorage;
  storage: DocumentStoragePort;
  ids: IdGeneratorPort;
  clock: ClockPort;
  /** PR-11 — REQUIS dès qu'un `equipmentId` est fourni (fail-closed, patron chantierTargets). */
  equipments?: EquipmentRepository;
  /** PR-15 — REQUIS dès qu'un `interventionId` est fourni (fail-closed, même patron). */
  interventions?: InterventionRepository;
}

/**
 * Photo liée à un chantier/projet — grille de vignettes sur la fiche chantier. Les octets vont au
 * MÊME DocumentStoragePort que le coffre documents (Supabase aujourd'hui) ; seules les métadonnées
 * vivent dans une table dédiée (WorksiteMediaStorage), séparée du coffre fiscal (pas de rétention
 * légale à porter sur une photo de chantier).
 */
export class UploadWorksitePhoto {
  constructor(private readonly deps: UploadWorksitePhotoDeps) {}

  async execute(input: UploadWorksitePhotoInput): Promise<Result<WorksiteMediaItem, AppError>> {
    const chantier = await this.deps.chantiers.findById(input.chantierId);
    if (!chantier || chantier.companyId !== input.companyId)
      return err(appNotFound('chantier', input.chantierId));

    // PR-11 — cohérence équipement↔site PROUVÉE avant tout octet stocké (fail-closed).
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
        return err(appDomain({
          code: 'VALIDATION',
          field: 'equipmentId',
          message: 'Cet équipement appartient à un autre site.',
        }));
    }

    // PR-15 — photo de PASSAGE : fiche prouvée dans le tenant, sur le MÊME site, et encore
    // OUVERTE aux traces (avant `signed` — machine §3.3/§3.4 : une fiche signée est
    // verrouillée, une annulée n'accumule plus rien). La phase avant/après exige la fiche.
    const interventionId = input.interventionId?.trim() || null;
    const phase = input.phase ?? null;
    if (phase !== null && !INTERVENTION_PHOTO_PHASES.includes(phase))
      return err(appDomain({ code: 'VALIDATION', field: 'phase', message: 'Phase de photo invalide (before | after).' }));
    if (phase !== null && interventionId === null)
      return err(appDomain({
        code: 'VALIDATION',
        field: 'phase',
        message: 'La phase avant/après exige la fiche de passage visée.',
      }));
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
        return err(appDomain({
          code: 'VALIDATION',
          field: 'interventionId',
          message: 'Cette fiche de passage appartient à un autre site.',
        }));
      if (!intervention.acceptsFieldTraces())
        return err(appDomain({
          code: 'VALIDATION',
          field: 'interventionId',
          message: interventionFieldTraceRefusal(intervention.status),
        }));
      // [Revue adversariale 28/07 — finding 6] La phase est une AFFIRMATION datée sur la pièce
      // de preuve : elle doit être cohérente avec la machine à états (§3.3), pas seulement avec
      // l'existence de la fiche. Le refus est ACTIONNABLE et ne perd aucune preuve : la même
      // photo reste joignable à la fiche SANS phase.
      if (phase !== null && !intervention.acceptsPhotoPhase(phase))
        return err(appDomain({
          code: 'VALIDATION',
          field: 'phase',
          message: interventionPhotoPhaseRefusal(phase, intervention.status),
        }));
    }

    if (!input.contentType.startsWith('image/'))
      return err(appDomain({ code: 'VALIDATION', field: 'contentType', message: 'Seules les images sont acceptées.' }));
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_PHOTO_BYTES)
      return err(appDomain({ code: 'VALIDATION', field: 'bytes', message: 'Photo vide ou trop volumineuse (15 Mo max).' }));

    const id = this.deps.ids.newId();
    const extension = input.contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg';
    const storageKey = `companies/${input.companyId}/chantiers/${input.chantierId}/photos/${id}.${extension}`;
    const stored = await this.deps.storage.put({
      companyId: input.companyId,
      key: storageKey,
      bytes: input.bytes,
      contentType: input.contentType,
    });

    const item: WorksiteMediaItem = {
      id,
      companyId: input.companyId,
      chantierId: input.chantierId,
      filename: input.filename.trim() || `photo-${id}.${extension}`,
      mimeType: input.contentType,
      byteSize: stored.sizeBytes,
      storageKey,
      createdAt: this.deps.clock.now(),
      equipmentId,
      interventionId,
      phase: interventionId === null ? null : phase,
    };
    await this.deps.media.save(item);
    return ok(item);
  }
}
