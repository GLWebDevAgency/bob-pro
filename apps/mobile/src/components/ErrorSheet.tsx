import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Button, Sheet, font, useTheme } from '@bob/ui';

/**
 * ErrorSheet — remplaçant premium des Alert.alert natifs du flow encaissement/génération/
 * émission (bug terrain : modale système grise au milieu d'un parcours Bob). Feuille @bob/ui
 * (titre + message + bouton OK) : reduce-motion respecté par Sheet, cible ≥ 44 pt par Button.
 * Hook LOCAL au composant appelant (pas de contexte global — l'`alertError` de hooks.ts est
 * un chantier séparé) : `showError` garde exactement les textes d'origine, la dernière
 * notification remplace la précédente (jamais d'empilement de feuilles).
 */
interface ErrorNotice {
  readonly title: string;
  readonly message?: string;
}

export interface ErrorSheetHandle {
  /**
   * Affiche la feuille. `onDismiss` (optionnel) est appelé UNE fois à la fermeture — bouton
   * OK ou scrim — pour séquencer une suite (ex. navigation) APRÈS que l'utilisateur a lu.
   */
  readonly showError: (title: string, message?: string, onDismiss?: () => void) => void;
  /** À rendre dans chaque branche du composant appelant susceptible de signaler une erreur. */
  readonly errorSheet: ReactNode;
}

export function useErrorSheet(): ErrorSheetHandle {
  const [visible, setVisible] = useState(false);
  // La notice survit à `visible=false` : le contenu reste rendu pendant l'animation de sortie.
  const [notice, setNotice] = useState<ErrorNotice | null>(null);
  const onDismissRef = useRef<(() => void) | null>(null);

  const showError = useCallback((title: string, message?: string, onDismiss?: () => void) => {
    onDismissRef.current = onDismiss ?? null;
    setNotice({ title, ...(message !== undefined ? { message } : {}) });
    setVisible(true);
  }, []);

  const dismiss = useCallback(() => {
    setVisible(false);
    const onDismiss = onDismissRef.current;
    onDismissRef.current = null;
    onDismiss?.();
  }, []);

  return {
    showError,
    errorSheet: <ErrorSheet visible={visible} notice={notice} onClose={dismiss} />,
  };
}

function ErrorSheet({
  visible,
  notice,
  onClose,
}: {
  readonly visible: boolean;
  readonly notice: ErrorNotice | null;
  readonly onClose: () => void;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <Sheet
      visible={visible && notice !== null}
      onClose={onClose}
      accessibilityLabel={notice?.title ?? 'Erreur'}
      closeAccessibilityLabel="Fermer"
    >
      {notice !== null ? (
        <>
          <Text
            accessibilityRole="header"
            style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
          >
            {notice.title}
          </Text>
          {notice.message !== undefined ? (
            <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 14 }]}>
              {notice.message}
            </Text>
          ) : null}
          <View style={{ marginBottom: 8, marginTop: notice.message === undefined ? 6 : 0 }}>
            <Button title="OK" onPress={onClose} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}
