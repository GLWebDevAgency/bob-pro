export interface StoredObject {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface DocumentStoragePort {
  /**
   * Stocke un objet en refusant d'écraser une clé existante.
   * Le port calcule le sha256 réel du flux stocké, utilisé ensuite par les métadonnées document.
   */
  put(input: { companyId: string; key: string; bytes: Uint8Array; contentType: string }): Promise<StoredObject>;
  get(companyId: string, key: string): Promise<{ bytes: Uint8Array; contentType: string } | null>;
  getSignedUrl(companyId: string, key: string, ttlSeconds: number): Promise<string>;
  stat(companyId: string, key: string): Promise<{ sizeBytes: number; contentType: string } | null>;
  /** Purge légale uniquement, après rétention et journal d'audit. */
  remove(companyId: string, key: string): Promise<void>;
}
