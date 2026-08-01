/**
 * ErrorNotice — l'erreur à DEUX FACES (SPEC_SYSTEME_ERREUR §6), le composant de référence de la
 * règle anti-écrasement : face utilisateur (message actionnable + code court discret), face
 * développeur au chevron ou à l'appui long (kind, corrélation complète, heure, partage sans
 * PII). Le message vient de l'écran DÉJÀ discriminé et i18n-isé — ce composant ne reformule
 * jamais. Zéro hex : toute couleur vient de @bob/tokens via useTheme() (token-lint).
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme, font } from '../theme';
import {
  ERROR_NOTICE_HIT_TARGET,
  errorNoticeAccessibilitySummary,
  errorNoticeReportText,
  resolveErrorNoticeCopy,
  shortCorrelation,
  shortTime,
  type ErrorNoticeFacts,
} from './error-notice.logic';

export interface ErrorNoticeProps extends ErrorNoticeFacts {
  /** Message actionnable, déjà discriminé et traduit par l'écran (×3 tons). */
  readonly message: string;
  /** Fourni par l'écran (Share natif…) — sans lui, le bouton de partage n'existe pas. */
  readonly onShareReport?: (reportText: string) => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
      <Text style={[font('meta', 600), { color: colors.slate400, minWidth: 84 }]}>{label}</Text>
      <Text selectable style={[font('meta'), { color: colors.ink800, flexShrink: 1 }]}>
        {value}
      </Text>
    </View>
  );
}

export function ErrorNotice({
  message,
  code,
  correlationId,
  kind,
  at,
  onShareReport,
}: ErrorNoticeProps) {
  const { colors, semantic, controls, radius, personality } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const copy = resolveErrorNoticeCopy(personality);
  const facts: ErrorNoticeFacts = {
    code,
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(at !== undefined ? { at } : {}),
  };

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        borderWidth: 1,
        borderColor: semantic.danger,
        backgroundColor: semantic.dangerBg,
        borderRadius: radius.card,
        paddingHorizontal: 12,
        paddingVertical: 10,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={errorNoticeAccessibilitySummary(message, code)}
        accessibilityHint={copy.detailsHint}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((open) => !open)}
        onLongPress={() => setExpanded(true)}
        style={{ minHeight: ERROR_NOTICE_HIT_TARGET, justifyContent: 'center' }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]}>{message}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 }}>
              <View
                style={{
                  borderRadius: 6,
                  backgroundColor: controls.segmentedTrack,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                <Text
                  allowFontScaling={false}
                  style={[font('meta', 700), { color: colors.slate500, fontSize: 11 }]}
                >
                  {code}
                </Text>
              </View>
              <Text style={[font('meta'), { color: colors.slate400 }]}>
                {expanded ? copy.hideLabel : copy.detailsLabel}
              </Text>
            </View>
          </View>
          <Text
            accessible={false}
            allowFontScaling={false}
            style={{ color: colors.slate400, fontSize: 13, fontWeight: '700' }}
          >
            {expanded ? '▴' : '▾'}
          </Text>
        </View>
      </Pressable>

      {expanded ? (
        <View
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTopWidth: 1,
            borderTopColor: controls.cardBorder,
          }}
        >
          <DetailRow label={copy.referenceLabel} value={code} />
          {kind ? <DetailRow label={copy.kindLabel} value={kind} /> : null}
          {correlationId ? (
            <DetailRow
              label={copy.correlationLabel}
              value={`${shortCorrelation(correlationId)} (${correlationId})`}
            />
          ) : null}
          {at && shortTime(at) !== '' ? <DetailRow label={copy.atLabel} value={shortTime(at)} /> : null}
          {onShareReport ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.shareLabel}
              onPress={() => onShareReport(errorNoticeReportText(facts))}
              style={{
                minHeight: ERROR_NOTICE_HIT_TARGET,
                justifyContent: 'center',
                alignSelf: 'flex-start',
              }}
            >
              <Text style={[font('sub', 700), { color: semantic.danger }]}>{copy.shareLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
