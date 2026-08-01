/**
 * ErrorNotice — l'erreur à DEUX FACES (SPEC_SYSTEME_ERREUR §6), le composant de référence de la
 * règle anti-écrasement : face utilisateur (message actionnable + code court discret), face
 * développeur au chevron ou à l'appui long (kind, corrélation complète, heure, partage sans
 * PII). Le message vient de l'écran DÉJÀ discriminé et i18n-isé — ce composant ne reformule
 * jamais. Zéro hex : toute couleur vient de @bob/tokens via useTheme() (token-lint).
 * Lot 0 (plan DA 01/08) : `appearance="dark"` additive — la matière danger SOMBRE du kit
 * (panneaux du diagnostic) ; le défaut `light` rend l'arbre HISTORIQUE inchangé.
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTheme, font } from '../theme';
import {
  ERROR_NOTICE_HIT_TARGET,
  errorNoticeAccessibilitySummary,
  errorNoticeDarkFace,
  errorNoticeReportText,
  resolveErrorNoticeCopy,
  shortCorrelation,
  shortTime,
  type ErrorNoticeAppearance,
  type ErrorNoticeFacts,
} from './error-notice.logic';

export type { ErrorNoticeAppearance };

export interface ErrorNoticeProps extends ErrorNoticeFacts {
  /** Message actionnable, déjà discriminé et traduit par l'écran (×3 tons). */
  readonly message: string;
  /** Fourni par l'écran (Share natif…) — sans lui, le bouton de partage n'existe pas. */
  readonly onShareReport?: (reportText: string) => void;
  /** Face sombre (Lot 0) — panneaux on-dark ; défaut `light` = rendu historique. */
  readonly appearance?: ErrorNoticeAppearance;
}

function DetailRow({ label, value, labelColor, valueColor }: {
  label: string;
  value: string;
  labelColor: string;
  valueColor: string;
}) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
      <Text style={[font('meta', 600), { color: labelColor, minWidth: 84 }]}>{label}</Text>
      <Text selectable style={[font('meta'), { color: valueColor, flexShrink: 1 }]}>
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
  appearance = 'light',
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
  // Face sombre : matière danger sombre du kit ; face claire : les MÊMES tokens qu'avant.
  const dark = appearance === 'dark' ? errorNoticeDarkFace() : null;
  const borderColor = dark?.border ?? semantic.danger;
  const backgroundColor = dark?.bg ?? semantic.dangerBg;
  const messageColor = dark?.ink ?? colors.ink800;
  const chipBg = dark?.chipBg ?? controls.segmentedTrack;
  const chipText = dark?.inkMuted ?? colors.slate500;
  const hintColor = dark?.inkMuted ?? colors.slate400;
  const dividerColor = dark?.border ?? controls.cardBorder;
  const detailLabelColor = dark?.inkMuted ?? colors.slate400;
  const detailValueColor = dark?.ink ?? colors.ink800;
  const shareColor = dark?.ink ?? semantic.danger;

  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        borderWidth: 1,
        borderColor,
        backgroundColor,
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
            <Text style={[font('sub'), { color: messageColor, lineHeight: 19 }]}>{message}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 }}>
              <View
                style={{
                  borderRadius: 6,
                  backgroundColor: chipBg,
                  paddingHorizontal: 6,
                  paddingVertical: 2,
                }}
              >
                <Text
                  allowFontScaling={false}
                  style={[font('meta', 700), { color: chipText, fontSize: 11 }]}
                >
                  {code}
                </Text>
              </View>
              <Text style={[font('meta'), { color: hintColor }]}>
                {expanded ? copy.hideLabel : copy.detailsLabel}
              </Text>
            </View>
          </View>
          <Text
            accessible={false}
            allowFontScaling={false}
            style={{ color: hintColor, fontSize: 13, fontWeight: '700' }}
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
            borderTopColor: dividerColor,
          }}
        >
          <DetailRow
            label={copy.referenceLabel}
            value={code}
            labelColor={detailLabelColor}
            valueColor={detailValueColor}
          />
          {kind ? (
            <DetailRow
              label={copy.kindLabel}
              value={kind}
              labelColor={detailLabelColor}
              valueColor={detailValueColor}
            />
          ) : null}
          {correlationId ? (
            <DetailRow
              label={copy.correlationLabel}
              value={`${shortCorrelation(correlationId)} (${correlationId})`}
              labelColor={detailLabelColor}
              valueColor={detailValueColor}
            />
          ) : null}
          {at && shortTime(at) !== '' ? (
            <DetailRow
              label={copy.atLabel}
              value={shortTime(at)}
              labelColor={detailLabelColor}
              valueColor={detailValueColor}
            />
          ) : null}
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
              <Text style={[font('sub', 700), { color: shareColor }]}>{copy.shareLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
