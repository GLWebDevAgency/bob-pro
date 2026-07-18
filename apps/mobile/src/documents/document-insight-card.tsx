/**
 * Carte « Ce que Bob a compris » PARTAGÉE (mission « écran document = carte du scan ») —
 * exactement la carte de référence du scan (handoff §SCAN OVERLAY, résultat) :
 * pastille verte « Document lu » → TITRE INTELLIGENT (libellé professionnel, jamais un nom
 * de fichier brut) + badge de confiance → sous-libellé type → résumé → tableau Montant TTC /
 * TVA récupérable (vert) / Rattaché à (indigo) → chips #tags → warnings. Les actions
 * (CTA « Classer dans {label} », Confirmer, Voir l'original…) restent à l'appelant via
 * `actions` — le scan et l'écran détail branchent les leurs sans dupliquer le rendu.
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import { t } from '@bob/i18n';
import { useTheme } from '../theme';
import { Badge, Card, font } from '../components/ui';
import type { DocumentInsightModel } from './document-insight-card.logic';

export function DocumentInsightCard({
  insight,
  actions,
}: {
  insight: DocumentInsightModel;
  /** Zone d'actions sous la carte (CTA rangement, confirmation, original) — optionnelle. */
  actions?: ReactNode;
}) {
  const { colors, semantic, personality } = useTheme();
  return (
    <Card>
      {/* Pastille verte « Document lu » (handoff §SCAN OVERLAY, résultat). */}
      <View
        accessibilityLiveRegion="polite"
        style={{
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          backgroundColor: semantic.successBg,
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: 20,
          marginBottom: 13,
        }}
      >
        <Ionicons name="checkmark" size={15} color={semantic.success} />
        <Text style={[font('meta'), { fontWeight: '700', fontSize: 13, color: semantic.success }]}>
          {t('scan.readDone', { personality })}
        </Text>
      </View>
      {/* TITRE INTELLIGENT — le libellé professionnel proposé, jamais un nom de fichier brut. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900, flex: 1 }]} numberOfLines={2}>
          {insight.title}
        </Text>
        <Badge
          label={`${insight.confidencePct} %`}
          tone={insight.requiresHumanReview ? 'warning' : 'success'}
          accessibilityLabel={t('docs.confidenceA11y', {
            personality,
            params: { pct: insight.confidencePct },
          })}
        />
      </View>
      <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
        {t(insight.typeLabelKey, { personality })}
      </Text>
      {insight.summary !== null ? (
        <Text style={[font('body'), { color: colors.slate500, lineHeight: 21, marginTop: 8 }]}>{insight.summary}</Text>
      ) : null}
      {/* Tableau du handoff : Montant TTC / TVA récupérable (vert) / Rattaché à (indigo). */}
      {insight.amountTtcCents !== null || insight.attachedToLabel !== null ? (
        <View style={{ marginTop: 12, borderTopWidth: 1, borderTopColor: colors.lineSoft, paddingTop: 4 }}>
          {insight.amountTtcCents !== null ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.lineSoft }}>
              <Text style={[font('sub'), { color: colors.slate400 }]}>{t('scan.amountTtc', { personality })}</Text>
              <Text style={[font('sub'), { color: colors.ink900, fontWeight: '700', fontVariant: ['tabular-nums'] }]}>
                {formatEUR(insight.amountTtcCents)}
              </Text>
            </View>
          ) : null}
          {insight.vatCents !== null ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.lineSoft }}>
              <Text style={[font('sub'), { color: colors.slate400 }]}>{t('scan.vatRecoverable', { personality })}</Text>
              <Text style={[font('sub'), { color: semantic.success, fontWeight: '700', fontVariant: ['tabular-nums'] }]}>
                {formatEUR(insight.vatCents)}
              </Text>
            </View>
          ) : null}
          {insight.attachedToLabel !== null ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 }}>
              <Text style={[font('sub'), { color: colors.slate400 }]}>{t('scan.attachedTo', { personality })}</Text>
              <Text style={[font('sub'), { color: semantic.ai, fontWeight: '700' }]} numberOfLines={1}>
                {insight.attachedToLabel}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {insight.tags.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          {insight.tags.map((tag) => <Badge key={tag} label={`#${tag}`} tone="ai" />)}
        </View>
      ) : null}
      {insight.warnings.map((warning) => (
        <Text key={warning} style={[font('meta'), { color: semantic.warning, marginTop: 9 }]}>• {warning}</Text>
      ))}
      {actions ? <View style={{ marginTop: 14, gap: 8 }}>{actions}</View> : null}
    </Card>
  );
}
