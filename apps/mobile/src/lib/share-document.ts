/**
 * Envoi d'un document du coffre au client (A4 — envoi PDF) : l'URL signée est téléchargée
 * dans le cache puis remise à la feuille de partage native (Mail, WhatsApp, AirDrop…) —
 * le client reçoit le VRAI fichier, pas un lien qui expirera. Repli honnête : partage
 * indisponible → 'unavailable' ; téléchargement/partage raté → 'error' (l'écran le dit).
 * Même famille que shareFec (source unique du pattern fichier → feuille de partage).
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

export type ShareDocumentResult = 'shared' | 'unavailable' | 'error';

export async function shareDocument(input: {
  url: string;
  filename: string;
  mimeType?: string;
}): Promise<ShareDocumentResult> {
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  try {
    const target = new File(Paths.cache, input.filename);
    // downloadFileAsync refuse d'écraser : on repart d'un cache propre (même pièce = même nom).
    if (target.exists) target.delete();
    const file = await File.downloadFileAsync(input.url, target);
    await Sharing.shareAsync(file.uri, {
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      dialogTitle: input.filename,
    });
    return 'shared';
  } catch {
    return 'error';
  }
}
