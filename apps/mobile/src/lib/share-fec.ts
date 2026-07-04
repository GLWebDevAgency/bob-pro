/**
 * Export FEC partageable (claim C17) : le fichier .txt est ÉCRIT sur le device puis remis
 * à la feuille de partage native — l'artisan envoie le vrai FEC à son comptable (Mail,
 * WhatsApp, AirDrop…). Repli honnête : si le partage est indisponible (simulateur nu,
 * permission), on remonte 'unavailable' et l'écran garde son toast de confirmation.
 * Utilisé par Documents (C14) ET Comptabilité (C17) — source unique.
 */
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { encodeLatin9 } from '@bob/core';
import type { ExportFecClientOutput } from '@bob/api-client';

export type ShareFecResult = 'shared' | 'unavailable';

export async function shareFec(fec: ExportFecClientOutput): Promise<ShareFecResult> {
  if (!(await Sharing.isAvailableAsync())) return 'unavailable';
  const file = new File(Paths.cache, fec.filename);
  // E9 : le FEC remis au comptable s'encode en ISO 8859-15 (arrêté du 29/07/2013) —
  // le répertoire Latin-9 couvre tout le français, les rares hors-champ deviennent « ? ».
  if (fec.mimeType.includes('iso-8859-15')) {
    file.write(encodeLatin9(fec.content).bytes);
  } else {
    // Écrase un export précédent du même nom (le FEC est déterministe par période).
    file.write(fec.content);
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: fec.mimeType || 'text/plain',
    dialogTitle: fec.filename,
  });
  return 'shared';
}
