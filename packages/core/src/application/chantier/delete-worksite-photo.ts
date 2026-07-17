import { type Result, ok, err } from '../../shared-kernel/result';
import { type AppError, appNotFound } from '../result';
import { type WorksiteMediaStorage } from '../ports/worksite-media';
import { type DocumentStoragePort } from '../ports/document-storage';

export interface DeleteWorksitePhotoInput {
  companyId: string;
  id: string;
}

export interface DeleteWorksitePhotoDeps {
  media: WorksiteMediaStorage;
  storage: DocumentStoragePort;
}

/** Suppression d'une photo de chantier (ConfirmSheet côté app) — octets ET métadonnée retirés. */
export class DeleteWorksitePhoto {
  constructor(private readonly deps: DeleteWorksitePhotoDeps) {}

  async execute(input: DeleteWorksitePhotoInput): Promise<Result<void, AppError>> {
    const item = await this.deps.media.findById(input.companyId, input.id);
    if (!item) return err(appNotFound('worksite_photo', input.id));
    await this.deps.storage.remove(input.companyId, item.storageKey);
    await this.deps.media.remove(input.companyId, input.id);
    return ok(undefined);
  }
}
