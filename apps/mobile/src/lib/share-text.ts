/**
 * Partage d'un document TEXTE lisible (DOSSIER-1 : la note de synthèse pour l'expert-comptable).
 * Écrit le contenu en UTF-8 dans le cache puis le remet à la feuille de partage native.
 * Contrairement au FEC (ISO 8859-15 exigé par l'admin fiscale), ce document est destiné à un
 * humain : UTF-8 convient. Repli honnête : partage indisponible → 'unavailable'.
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export type ShareTextResult = 'shared' | 'unavailable';

export async function shareTextFile(input: { filename: string; content: string }): Promise<ShareTextResult> {
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  const file = new File(Paths.cache, input.filename);
  if (file.exists) file.delete();
  file.write(input.content);
  await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: input.filename });
  return 'shared';
}
