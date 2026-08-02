import { DOCUMENT_FOLDER_SYSTEM_KEYS, type DocumentFolderView } from '@bob/core';
import {
  folderTintFor,
  systemVaultFolderTintIndex,
  type VaultSystemFolderKey,
} from '@bob/tokens';
import { describe, expect, it } from 'vitest';

/**
 * Garde de frontière : @bob/tokens reste sans dépendance domaine, mais aucune nouvelle clé
 * persistée ne peut être livrée sans recevoir une identité visuelle explicite.
 */
describe('contrat domaine → teinte des dossiers du coffre', () => {
  it('conserve exactement les mêmes clés système, dans le même ordre contractuel', () => {
    const domainKeysAreTokenKeys: readonly VaultSystemFolderKey[] = DOCUMENT_FOLDER_SYSTEM_KEYS;

    expect(Object.keys(systemVaultFolderTintIndex)).toEqual(domainKeysAreTokenKeys);
    expect(new Set(Object.values(systemVaultFolderTintIndex)).size).toBe(
      DOCUMENT_FOLDER_SYSTEM_KEYS.length,
    );
  });

  it("utilise le systemKey réel d'une vue serveur, jamais son UUID tenant", () => {
    const tenantA = {
      id: 'tenant-a-folder-uuid',
      systemKey: 'purchases',
    } satisfies Pick<DocumentFolderView, 'id' | 'systemKey'>;
    const tenantB = {
      id: 'tenant-b-folder-uuid',
      systemKey: 'purchases',
    } satisfies Pick<DocumentFolderView, 'id' | 'systemKey'>;
    const first = folderTintFor(tenantA);
    const second = folderTintFor(tenantB);

    expect(first).toBe(second);
    expect(first).toEqual({ tint: '#0E7C5A', bg: '#EAF2EC' });
  });

  it("réserve le hachage stable à l'identifiant d'un dossier personnalisé", () => {
    const identity = { id: 'custom-folder-uuid', systemKey: null } as const;

    expect(folderTintFor(identity)).toBe(folderTintFor(identity));
  });
});
