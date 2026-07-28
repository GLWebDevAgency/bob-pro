import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appDomain, appNotFound } from '../result';
import { type IdGeneratorPort, type ClockPort } from '../ports/services';
import { type ChantierRepository } from '../ports/repositories';
import { type EquipmentRepository } from '../equipment/equipment-repository';
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
}

export interface UploadWorksitePhotoDeps {
  chantiers: ChantierRepository;
  media: WorksiteMediaStorage;
  storage: DocumentStoragePort;
  ids: IdGeneratorPort;
  clock: ClockPort;
  /** PR-11 — REQUIS dès qu'un `equipmentId` est fourni (fail-closed, patron chantierTargets). */
  equipments?: EquipmentRepository;
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
    };
    await this.deps.media.save(item);
    return ok(item);
  }
}
