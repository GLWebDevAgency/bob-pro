export interface StoredObjectMetadata {
  key: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}

/**
 * Preuve renvoyée par `put` après relecture de l'objet réellement stocké.
 * `created=false` signifie qu'un retry a retrouvé exactement le même objet : l'appelant ne doit
 * jamais le supprimer lors d'une compensation, car il peut appartenir à une tentative aboutie.
 */
export interface StoredObject extends StoredObjectMetadata {
  created: boolean;
}

/** Objet relu : les métadonnées sont calculées depuis les octets retournés, pas déclaratives. */
export interface LoadedStoredObject extends StoredObjectMetadata {
  bytes: Uint8Array;
}

export interface DocumentStoragePort {
  /**
   * Stocke un objet en refusant d'écraser une clé existante.
   * Le port calcule le sha256 réel du flux stocké, utilisé ensuite par les métadonnées document.
   */
  put(input: { companyId: string; key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject>;
  get(companyId: string, key: string): Promise<LoadedStoredObject | null>;
  getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string>;
  stat(companyId: string, key: string): Promise<{ sizeBytes: number; contentType: string } | null>;
  /** Purge légale uniquement, après rétention et journal d'audit. */
  remove(companyId: string, key: string): Promise<void>;
}
