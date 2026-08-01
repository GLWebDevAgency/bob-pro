import { Text, View } from 'react-native';
import type { RealtimeVoiceDiagnosticTraceDisclosure } from '@bob/api-client';
import { t } from '@bob/i18n';
import { Button, font, Sheet, useTheme } from '@bob/ui';
import { SparkIcon } from './icons';

export interface RealtimeDiagnosticTraceSheetProps {
  readonly disclosure: RealtimeVoiceDiagnosticTraceDisclosure | null;
  readonly confirmationPending: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Consentement explicite avant toute ouverture du micro en staging.
 *
 * Le serveur reste la source de vérité de la durée : l'app ne fabrique ni finalité ni délai.
 * Cette décision est rendue hors du chrome flottant afin de rester accessible sur les routes où
 * l'orbe Bob est volontairement masquée. Un refus ferme la session avant le premier octet audio.
 */
export function RealtimeDiagnosticTraceSheet({
  disclosure,
  confirmationPending,
  onConfirm,
  onCancel,
}: RealtimeDiagnosticTraceSheetProps) {
  const { colors, semantic, personality, radius } = useTheme();
  const visible = disclosure !== null && confirmationPending;
  const title = t('agent.global.diagnosticTraceTitle', { personality });
  const cancelLabel = t('agent.global.diagnosticTraceCancel', { personality });

  return (
    <Sheet
      visible={visible}
      onClose={onCancel}
      accessibilityLabel={title}
      closeAccessibilityLabel={cancelLabel}
      closeAccessibilityHint={cancelLabel}
    >
      <View
        accessible={false}
        importantForAccessibility="no"
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: semantic.aiBg,
          marginBottom: 12,
        }}
      >
        <SparkIcon color={semantic.aiInk} size={20} strokeWidth={2} />
      </View>

      <Text
        accessibilityRole="header"
        style={[font('pageTitle'), { color: colors.ink900, marginBottom: 8 }]}
      >
        {title}
      </Text>
      <Text style={[font('body'), { color: colors.ink600, lineHeight: 22, marginBottom: 16 }]}>
        {t('agent.global.diagnosticTrace', {
          personality,
          params: { retentionDays: disclosure?.retentionDays ?? 0 },
        })}
      </Text>

      <Button
        title={t('agent.global.diagnosticTraceConfirm', { personality })}
        variant="ai"
        radius={14}
        onPress={onConfirm}
      />
      <Button
        title={cancelLabel}
        variant="secondary"
        radius={14}
        onPress={onCancel}
        style={{ marginTop: 8 }}
      />
    </Sheet>
  );
}
