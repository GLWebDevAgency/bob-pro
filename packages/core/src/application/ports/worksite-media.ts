export interface WorksiteMediaItem {
  id: string;
  companyId: string;
  chantierId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
  createdAt: string;
}

/**
 * Métadonnées des photos de chantier — table DISTINCTE du coffre documents fiscal
 * (StoredDocument porte des règles de rétention/versions/classification propres aux pièces
 * légales, hors sujet pour une photo de chantier). Les OCTETS restent stockés via le MÊME
 * DocumentStoragePort déjà utilisé par le coffre (Supabase aujourd'hui, cf. apps/api/src/
 * documents/storage.ts) : la migration Cloudflare R2 (décidée post-V1, accès en cours
 * d'obtention) ne touchera QUE l'implémentation de DocumentStoragePort — jamais cette interface
 * ni ses appelants (UploadWorksitePhoto/DeleteWorksitePhoto).
 */
export interface WorksiteMediaStorage {
  save(item: WorksiteMediaItem): Promise<void>;
  listByChantier(companyId: string, chantierId: string): Promise<WorksiteMediaItem[]>;
  findById(companyId: string, id: string): Promise<WorksiteMediaItem | null>;
  remove(companyId: string, id: string): Promise<void>;
}
