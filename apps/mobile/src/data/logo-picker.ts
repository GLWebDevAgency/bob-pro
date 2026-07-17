/**
 * Choix du logo (Réglages facturation §Logo) — expo-image-picker (déjà une dépendance, réutilisé
 * de scan-document.tsx) puis copie PERSISTANTE (expo-file-system, Paths.document) : le fichier
 * renvoyé par le picker vit dans un cache éphémère, une copie est requise pour qu'il survive un
 * redémarrage de l'app. AUCUN champ `logoUrl` n'existe sur CompanyProps ni d'endpoint d'upload
 * dédié (vérifié packages/core/src/domain/company/company.ts + apps/api/src/api.controllers.ts) —
 * cette copie locale alimente UNIQUEMENT l'aperçu en direct (billing-prefs.ts `logoUri`), jamais
 * le PDF serveur généré : le branchement `company.logoUrl` + embed PNG dans
 * apps/api/src/documents/pdf-renderer.ts reste un TODO explicite, documenté dans billing-prefs.ts.
 */
import * as ImagePicker from 'expo-image-picker';
import { File, Paths } from 'expo-file-system';

export type PickLogoResult =
  | { kind: 'picked'; uri: string }
  | { kind: 'cancelled' }
  | { kind: 'permission_denied' }
  | { kind: 'error' };

export async function pickLogoFromLibrary(companyId: string): Promise<PickLogoResult> {
  try {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return { kind: 'permission_denied' };
    const res = await ImagePicker.launchImageLibraryAsync({
      base64: false,
      quality: 1,
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
    });
    if (res.canceled) return { kind: 'cancelled' };
    const asset = res.assets[0];
    if (!asset) return { kind: 'cancelled' };
    const extension = asset.uri.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
    const destination = new File(Paths.document, `bob-logo-${companyId}.${extension}`);
    if (destination.exists) destination.delete();
    new File(asset.uri).copy(destination);
    return { kind: 'picked', uri: destination.uri };
  } catch {
    return { kind: 'error' };
  }
}

/** Supprime la copie locale du logo (best-effort — un échec de suppression n'empêche jamais
 * l'utilisateur de continuer, la préférence `logoUri` est de toute façon effacée côté appelant). */
export function removeLogoFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* best-effort */
  }
}
