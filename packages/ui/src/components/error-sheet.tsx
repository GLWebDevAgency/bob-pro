/**
 * ErrorSheet — remplaçant premium des Alert.alert natifs (bug terrain : modale système grise
 * au milieu d'un parcours Bob). Feuille @bob/ui (titre + message + bouton OK) : reduce-motion
 * respecté par Sheet, cible ≥ 44 pt par Button. Hook LOCAL au composant appelant (pas de
 * contexte global) : `showError` garde exactement les textes d'origine, la dernière
 * notification remplace la précédente (jamais d'empilement de feuilles).
 *
 * PROMU de apps/mobile/src/components/ErrorSheet.tsx (Lot 0, plan DA 01/08 — arbitrage
 * GRAMMAIRE D'ERREUR : « ErrorSheet promu @bob/ui = tout échec de mutation appelable au
 * support »). Le chemin historique `showError(title, message?, onDismiss?)` rend un arbre
 * STRICTEMENT identique au composant local (prouvé par le test iso côté mobile) ; le lot
 * ajoute `showErrorFacts` : la même feuille portant un ErrorNotice 2 faces (code, corrélation,
 * kind, heure, partage sans PII) — la face que l'artisan montre au support depuis le chantier.
 */
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Button } from './button';
import { Sheet } from './sheet';
import { ErrorNotice } from './error-notice';
import type { ErrorNoticeFacts } from './error-notice.logic';
import { font, useTheme } from '../theme';

interface ErrorSheetNotice {
  readonly title: string;
  readonly message?: string;
  /** Faits techniques (Lot 0) — présents ⇒ la feuille rend l'ErrorNotice 2 faces. */
  readonly facts?: ErrorSheetFacts;
}

/** Faits de la face développeur + message actionnable (l'écran discrimine et traduit). */
export interface ErrorSheetFacts extends ErrorNoticeFacts {
  readonly message: string;
  /** Partage natif fourni par l'écran — sans lui, pas de bouton de partage. */
  readonly onShareReport?: (reportText: string) => void;
}

export interface ErrorSheetHandle {
  /**
   * Affiche la feuille. `onDismiss` (optionnel) est appelé UNE fois à la fermeture — bouton
   * OK ou scrim — pour séquencer une suite (ex. navigation) APRÈS que l'utilisateur a lu.
   */
  readonly showError: (title: string, message?: string, onDismiss?: () => void) => void;
  /**
   * Variante 2 faces (Lot 0) : même feuille, portant un ErrorNotice complet (code court,
   * corrélation, kind, heure, partage SANS PII) — pour tout échec de mutation appelable
   * au support. La dernière notification remplace la précédente, comme `showError`.
   */
  readonly showErrorFacts: (title: string, facts: ErrorSheetFacts, onDismiss?: () => void) => void;
  /** À rendre dans chaque branche du composant appelant susceptible de signaler une erreur. */
  readonly errorSheet: ReactNode;
}

export function useErrorSheet(): ErrorSheetHandle {
  const [visible, setVisible] = useState(false);
  // La notice survit à `visible=false` : le contenu reste rendu pendant l'animation de sortie.
  const [notice, setNotice] = useState<ErrorSheetNotice | null>(null);
  const onDismissRef = useRef<(() => void) | null>(null);

  const showError = useCallback((title: string, message?: string, onDismiss?: () => void) => {
    onDismissRef.current = onDismiss ?? null;
    setNotice({ title, ...(message !== undefined ? { message } : {}) });
    setVisible(true);
  }, []);

  const showErrorFacts = useCallback(
    (title: string, facts: ErrorSheetFacts, onDismiss?: () => void) => {
      onDismissRef.current = onDismiss ?? null;
      setNotice({ title, facts });
      setVisible(true);
    },
    [],
  );

  const dismiss = useCallback(() => {
    setVisible(false);
    const onDismiss = onDismissRef.current;
    onDismissRef.current = null;
    onDismiss?.();
  }, []);

  return {
    showError,
    showErrorFacts,
    errorSheet: <ErrorSheet visible={visible} notice={notice} onClose={dismiss} />,
  };
}

function ErrorSheet({
  visible,
  notice,
  onClose,
}: {
  readonly visible: boolean;
  readonly notice: ErrorSheetNotice | null;
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
          {notice.facts !== undefined ? (
            // Face 2 faces (Lot 0) : l'ErrorNotice kit porte message + code + corrélation.
            <View style={{ marginBottom: 14 }}>
              <ErrorNotice
                message={notice.facts.message}
                code={notice.facts.code}
                {...(notice.facts.correlationId !== undefined
                  ? { correlationId: notice.facts.correlationId }
                  : {})}
                {...(notice.facts.kind !== undefined ? { kind: notice.facts.kind } : {})}
                {...(notice.facts.at !== undefined ? { at: notice.facts.at } : {})}
                {...(notice.facts.onShareReport !== undefined
                  ? { onShareReport: notice.facts.onShareReport }
                  : {})}
              />
            </View>
          ) : notice.message !== undefined ? (
            <Text style={[font('sub'), { color: colors.slate500, lineHeight: 20, marginBottom: 14 }]}>
              {notice.message}
            </Text>
          ) : null}
          <View
            style={{
              marginBottom: 8,
              marginTop: notice.facts === undefined && notice.message === undefined ? 6 : 0,
            }}
          >
            <Button title="OK" onPress={onClose} />
          </View>
        </>
      ) : null}
    </Sheet>
  );
}
