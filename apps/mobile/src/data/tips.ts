import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

const DISMISSED = 'dismissed';

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
