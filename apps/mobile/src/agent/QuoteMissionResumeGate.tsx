import { Pressable, ScrollView, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { t, type Personality } from '@bob/i18n';
import { space } from '@bob/tokens';
import { Button, font, useTheme } from '@bob/ui';
import { CloseIcon } from '../components/icons';
import type {
  PresentQuoteAgentMissionResumeView,
} from './agent-mission-recovery-state';

export interface QuoteMissionResumeGateProps {
  readonly recovery: PresentQuoteAgentMissionResumeView;
  readonly pending: boolean;
  readonly failed: boolean;
  readonly personality: Personality;
  readonly topInset: number;
  readonly bottomInset: number;
  readonly onResume: () => void;
  readonly onLeave: () => void;
  readonly onClose: () => void;
}

/**
 * Porte de reprise explicite.
 *
 * Le montage est strictement passif : aucune session, parole, navigation ou mutation n'est
 * déclenchée avant un geste. Une mission expirée ne présente jamais un faux bouton « Reprendre » ;
 * elle ferme l'écran afin qu'un nouveau démarrage Bob relise l'autorité serveur.
 */
export function QuoteMissionResumeGate({
  recovery,
  pending,
  failed,
  personality,
  topInset,
  bottomInset,
  onResume,
  onLeave,
  onClose,
}: QuoteMissionResumeGateProps) {
  const { colors, semantic, controls, radius } = useTheme();
  const expired = recovery.mission.status === 'expired';
  const actionKey = expired
    ? 'devis.mission.resumeExpiredAction' as const
    : pending
      ? 'devis.mission.resumeLoading' as const
      : 'devis.mission.resumeAction' as const;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.bg,
        paddingTop: topInset + space[7],
        paddingBottom: bottomInset + space[7],
        paddingHorizontal: space[8],
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('devis.close', { personality })}
          disabled={pending}
          onPress={onClose}
          hitSlop={space[2]}
          style={({ pressed }) => ({
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: controls.segmentedTrack,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: pending ? 0.5 : pressed ? 0.72 : 1,
          })}
        >
          <CloseIcon color={colors.slate500} size={17} />
        </Pressable>
      </View>
      <ScrollView
        accessibilityLiveRegion="polite"
        style={{ flex: 1 }}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          alignItems: 'center',
          paddingHorizontal: space[5],
          paddingVertical: space[8],
        }}
      >
        <View
          accessible={false}
          style={{
            width: 72,
            height: 72,
            borderRadius: radius.pill,
            backgroundColor: semantic.aiBg,
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: space[10],
          }}
        >
          <Ionicons name="sparkles-outline" size={32} color={semantic.ai} />
        </View>
        <Text
          accessibilityRole="header"
          style={[
            font('screenH1'),
            { color: colors.ink900, textAlign: 'center', marginBottom: space[4] },
          ]}
        >
          {t(
            expired
              ? 'devis.mission.resumeExpiredTitle'
              : 'devis.mission.resumeTitle',
            { personality },
          )}
        </Text>
        <Text
          style={[
            font('body'),
            {
              color: colors.ink600,
              textAlign: 'center',
              lineHeight: 23,
              maxWidth: 340,
            },
          ]}
        >
          {t(
            expired
              ? 'devis.mission.resumeExpiredBody'
              : 'devis.mission.resumeBody',
            { personality },
          )}
        </Text>
        {failed ? (
          <Text
            accessibilityRole="alert"
            style={[
              font('sub'),
              {
                color: semantic.danger,
                textAlign: 'center',
                marginTop: space[6],
              },
            ]}
          >
            {t('live.error', { personality })}
          </Text>
        ) : null}
      </ScrollView>
      <Button
        title={t(actionKey, { personality })}
        accessibilityLabel={t(
          expired
            ? 'devis.mission.resumeExpiredAction'
            : 'devis.mission.resumeAction',
          { personality },
        )}
        loading={!expired && pending}
        disabled={!expired && pending}
        onPress={expired ? onLeave : onResume}
        variant="aiSolid"
      />
    </View>
  );
}
