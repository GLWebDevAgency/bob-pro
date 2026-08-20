import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { space } from '@bob/tokens';
import { Button, Card, font, useTheme } from '@bob/ui';
import type { JarvisCommandReceiptView, JarvisRunView } from '@bob/api-client';

import {
  JarvisRunCoordinator,
  evaluateJarvisRunCancellation,
  type JarvisRunPorts,
} from '../agent/jarvis-run-coordinator';

export interface JarvisRunDrainCardProps {
  readonly run: JarvisRunView;
  readonly coordinator: JarvisRunCoordinator;
  readonly ports: JarvisRunPorts;
  readonly refreshFailed: boolean;
  readonly onAuthoritativeRefresh: (receipt?: JarvisCommandReceiptView) => void;
}

/**
 * Surface de secours d'un run dont les détails métier ne sont pas présentables.
 *
 * Elle ne possède que deux pouvoirs bornés : relire et demander l'annulation avec la référence
 * d'action dérivée par le serveur. Aucun accusé, rejet ou engagement métier n'est possible ici.
 */
export function JarvisRunDrainCard({
  run,
  coordinator,
  ports,
  refreshFailed,
  onAuthoritativeRefresh,
}: JarvisRunDrainCardProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const cancellation = evaluateJarvisRunCancellation(run);
  const cancellable = cancellation.status === 'available';
  const cancelAccessibilityLabel = cancellable
    ? 'Annuler la demande. Bob annule ce qui peut encore l’être, puis relit son état'
    : cancellation.reason === 'cancelling'
      ? 'Annuler la demande indisponible. Une annulation est déjà en cours'
      : cancellation.reason === 'terminal'
        ? 'Annuler la demande indisponible. La demande est déjà terminée'
        : 'Annuler la demande indisponible. L’identité de la demande n’est pas vérifiée';

  const cancel = async (): Promise<void> => {
    if (inFlight.current || !cancellable) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = await coordinator.cancel(run, ports);
      if (result.status === 'completed') {
        onAuthoritativeRefresh(result.value);
        return;
      }
      if (result.status === 'failed' && result.error.kind === 'conflict') {
        onAuthoritativeRefresh();
        return;
      }
      setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Card padding={space[7]}>
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900 }]}>
        État de la demande Bob
      </Text>
      <Text style={[font('sub'), { color: colors.slate500, marginTop: space[2] }]}>
        Bob n’arrive pas à afficher les détails de cette demande.{' '}
        {cancellable
          ? 'Vous pouvez les relire ou lui demander d’annuler ce qui peut encore l’être.'
          : 'Réessayez la lecture pour retrouver un état sûr.'}
      </Text>
      {refreshFailed ? (
        <Text
          accessibilityRole="alert"
          style={[font('sub'), { color: colors.ink900, marginTop: space[3] }]}
        >
          La dernière relecture a échoué. Les contrôles déjà vérifiés restent affichés.
        </Text>
      ) : null}
      {cancellation.status === 'unavailable' && cancellation.reason === 'cancelling' ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[font('sub'), { color: colors.ink900, marginTop: space[3] }]}
        >
          L’annulation est déjà en cours. Relisez la demande pour connaître son état.
        </Text>
      ) : cancellation.status === 'unavailable' && cancellation.reason === 'terminal' ? (
        <Text
          accessibilityLiveRegion="polite"
          style={[font('sub'), { color: colors.ink900, marginTop: space[3] }]}
        >
          Cette demande est déjà terminée. Relisez l’écran pour mettre à jour son affichage.
        </Text>
      ) : !cancellable ? (
        <Text
          accessibilityRole="alert"
          style={[font('sub'), { color: colors.ink900, marginTop: space[3] }]}
        >
          Bob ne peut pas encore identifier cette demande de façon sûre. Réessayez la lecture.
        </Text>
      ) : null}
      {failed ? (
        <Text
          accessibilityRole="alert"
          style={[font('sub'), { color: colors.ink900, marginTop: space[3] }]}
        >
          Bob n’a pas pu enregistrer l’annulation. Relisez la demande avant de réessayer.
        </Text>
      ) : null}
      <View style={{ gap: space[3], marginTop: space[5] }}>
        <Button
          title="Réessayer"
          variant="secondary"
          disabled={busy}
          accessibilityLabel="Réessayer d’afficher les détails de la demande"
          onPress={() => onAuthoritativeRefresh()}
        />
        <Button
          title="Annuler la demande"
          variant="danger"
          loading={busy}
          disabled={busy || !cancellable}
          accessibilityLabel={cancelAccessibilityLabel}
          onPress={() => {
            void cancel();
          }}
        />
      </View>
    </Card>
  );
}
