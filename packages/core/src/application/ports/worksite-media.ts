export interface WorksiteMediaItem {
  id: string;
  companyId: string;
  chantierId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  storageKey: string;
  createdAt: string;
  /** PR-11 (Bloc A) — équipement du site visé par la photo (tag ADDITIF) : absent/null =
   * photo du site. Cohérence équipement↔site prouvée par UploadWorksitePhoto (fail-closed). */
  equipmentId?: string | null;
  /** PR-15 (Bloc C) — fiche de passage visée par la photo (tag ADDITIF) : absent/null =
   * photo du site hors passage. Cohérence fiche↔site prouvée au use case (fail-closed) ;
   * une fiche SIGNÉE n'accepte plus aucune photo (§3.4 — verrou re-vérifié par trigger). */
  interventionId?: string | null;
  /** PR-15 — phase avant/après du passage : n'a de sens QUE taguée à une fiche. */
  phase?: 'before' | 'after' | null;
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
  /** Agrégat bulk (1 requête, groupBy) : nombre de photos par chantier pour TOUT le tenant —
   * alimente la liste des chantiers (compteurs de rangée) sans repasser en N+1 par chantier.
   * Ne contient que les chantiers ayant au moins une photo (absent = 0). */
  countByCompany(companyId: string): Promise<Map<string, number>>;
}
