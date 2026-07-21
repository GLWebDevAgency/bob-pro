import { type Result, err, ok } from '../../shared-kernel/result';
import { type DocumentStoragePort, type LoadedStoredObject } from '../ports/document-storage';
import { type AppError } from '../result';

export interface ExpectedStoredObject {
  companyId: string;
  key: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}

export function normalizeDocumentContentType(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function storageDependency(cause: string): Result<never, AppError> {
  return err({ kind: 'dependency', port: 'document-storage', cause });
}

/**
 * Relit et vérifie un original contre la preuve immuable portée par Document/DocumentVersion.
 * Le port de stockage doit calculer `sha256` depuis les octets téléchargés ; aucune valeur issue
 * des seules métadonnées distantes n'est acceptée comme preuve d'intégrité.
 */
export async function loadVerifiedStoredObject(
  storage: DocumentStoragePort,
  expected: ExpectedStoredObject,
): Promise<Result<LoadedStoredObject, AppError>> {
  let stored: LoadedStoredObject | null;
  try {
    stored = await storage.get(expected.companyId, expected.key);
  } catch (error) {
    return storageDependency(error instanceof Error ? error.message : String(error));
  }
  if (stored === null) return storageDependency('Original archivé introuvable.');
  if (stored.key !== expected.key) return storageDependency('Clé de l’original incohérente.');
  if (stored.bytes.byteLength !== expected.sizeBytes || stored.sizeBytes !== expected.sizeBytes) {
    return storageDependency('Taille de l’original incohérente avec les métadonnées.');
  }
  if (stored.sha256 !== expected.sha256) {
    return storageDependency('Empreinte SHA-256 de l’original incohérente avec les métadonnées.');
  }
  if (
    normalizeDocumentContentType(stored.contentType)
    !== normalizeDocumentContentType(expected.contentType)
  ) {
    return storageDependency('Type MIME de l’original incohérent avec les métadonnées.');
  }
  return ok(stored);
}
