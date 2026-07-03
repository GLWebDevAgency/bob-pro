import { normalizeFilename, normalizeSupplierName, vaultFolderOf, type VaultDocumentData } from './derive-vault-view';

/**
 * Use case pur « recherche dans le coffre » (claim C14) : filtre normalisé (casse/accents)
 * sur nom de fichier + clé de dossier. Chaque mot de la requête doit matcher (ET logique).
 * Même dérivation pour l'écran Documents et pour Bob (parité d'actions).
 */
export function searchVault(
  documents: readonly VaultDocumentData[],
  query: string,
): VaultDocumentData[] {
  const tokens = normalizeSupplierName(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [...documents];
  return documents
    .filter((doc) => {
      const haystack = `${normalizeFilename(doc.filename)} ${vaultFolderOf(doc) ?? ''}`;
      return tokens.every((t) => haystack.includes(t));
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
