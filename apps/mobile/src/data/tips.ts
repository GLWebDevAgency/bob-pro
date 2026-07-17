import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

const DISMISSED = 'dismissed';

/**
 * Registre des clés d'astuces first-run connues — SecureStore n'offre pas d'énumération par
 * préfixe, donc « Revoir les astuces » (modale menu profil) doit connaître la liste exacte à
 * effacer. Un nouvel appel à `useFirstTimeTip(key)` DOIT ajouter sa clé ici, sinon son dismiss
 * ne sera jamais réinitialisable depuis le menu.
 */
export const KNOWN_TIP_KEYS: readonly string[] = ['bob.tips.argent.v1'];

/** Réaffiche toutes les astuces first-run déjà fermées (best-effort, une clé illisible n'empêche
 * pas les autres) — consommé par le menu profil « Revoir les astuces ». */
export async function resetAllTips(): Promise<void> {
  await Promise.all(
    KNOWN_TIP_KEYS.map((key) => SecureStore.deleteItemAsync(key).catch(() => undefined)),
  );
}

/**
 * Astuce « première fois » d'un écran (coach-mark C11+) : visible tant qu'elle n'a pas été
 * fermée, dismiss persisté via une clé SecureStore dédiée (même famille de persistance que
 * les préférences du ThemeProvider). Invisible tant que la lecture n'a pas répondu — jamais
 * de flash de l'astuce chez qui l'a déjà passée ; stockage indisponible → on ne l'affiche pas.
 */
export function useFirstTimeTip(key: string): { visible: boolean; dismiss: () => void } {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync(key)
      .then((value) => {
        if (active && value !== DISMISSED) setVisible(true);
      })
      .catch(() => {
        /* stockage illisible → pas d'astuce plutôt qu'une astuce en boucle */
      });
    return () => {
      active = false;
    };
  }, [key]);

  const dismiss = useCallback(() => {
    setVisible(false);
    void SecureStore.setItemAsync(key, DISMISSED).catch(() => undefined); // best-effort
  }, [key]);

  return { visible, dismiss };
}
