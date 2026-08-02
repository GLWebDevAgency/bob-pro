/**
 * DeadlineRow — rangée d'échéance (Lot 1, plan DA 01/08) : date FR courte en colonne fixe,
 * intitulé, explication à la voix de Bob — JAMAIS de montant (les échéances fiscales v1 n'en
 * portent pas ; P03/P23 les brancheront). Promue du FiscalDeadlineRow local d'argent.tsx.
 *
 * A11Y HONNÊTE (critère de preuve Lot 1) : le lecteur d'écran entend TOUT ce que l'œil voit —
 * date, intitulé, badge d'hypothèse (« à confirmer ») ET l'explication ; l'ancien label local
 * s'arrêtait à l'intitulé. Crans de l'échelle uniquement (arbitrage : aucune demi-taille) :
 * date label/700 (13), intitulé body/600 (14.5), explication meta (12).
 */
import { Text, View } from 'react-native';
import { font, useTheme } from '../theme';
import { StatusBadge } from './status-badge';
import type { StatusBadgeVariant } from './status-badge.logic';
import { SkeletonTextLine } from './skeleton';

export interface DeadlineRowProps {
  /** Date déjà formatée par l'écran (ex. « 15 sept. ») — la présentation de date reste i18n/écran. */
  readonly dateLabel: string;
  readonly title: string;
  /** L'explication à la voix de Bob — pourquoi cette échéance existe. */
  readonly explain: string;
  /** Badge d'hypothèse (ex. « à confirmer ») — rendu ET annoncé ; absent = rien. */
  readonly badgeLabel?: string;
  /** Teinte du badge d'hypothèse (défaut 'particulier' — l'existant d'argent.tsx). */
  readonly badgeVariant?: StatusBadgeVariant;
  /** Dernière rangée : pas de séparateur bas. */
  readonly last?: boolean;
}

export function DeadlineRow({
  dateLabel,
  title,
  explain,
  badgeLabel,
  badgeVariant = 'particulier',
  last = false,
}: DeadlineRowProps) {
  const { colors } = useTheme();
  const announced = badgeLabel !== undefined ? `${title}, ${badgeLabel}` : title;
  return (
    <View
      accessible
      accessibilityLabel={`${dateLabel}, ${announced}. ${explain}`}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 11,
        ...(last ? {} : { borderBottomWidth: 1, borderBottomColor: colors.lineSoft }),
      }}
    >
      <View style={{ minWidth: 62 }}>
        <Text style={[font('label', 700), { color: colors.ink800, fontVariant: ['tabular-nums'] }]}>
          {dateLabel}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Text
            numberOfLines={2}
            style={[font('body', 600), { color: colors.ink800, flexShrink: 1 }]}
          >
            {title}
          </Text>
          {badgeLabel !== undefined ? (
            <StatusBadge label={badgeLabel} variant={badgeVariant} />
          ) : null}
        </View>
        <Text style={[font('meta'), { color: colors.slate500, marginTop: 2, lineHeight: 16 }]}>
          {explain}
        </Text>
      </View>
    </View>
  );
}

export interface DeadlineRowSkeletonProps {
  readonly last?: boolean;
}

/** Échéance en chargement — MÊME gabarit que DeadlineRow (padding V 11, colonne date 62,
 *  intitulé + explication). Zéro saut à l'arrivée des données. */
export function DeadlineRowSkeleton({ last = false }: DeadlineRowSkeletonProps) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 11,
        ...(last ? {} : { borderBottomWidth: 1, borderBottomColor: colors.lineSoft }),
      }}
    >
      <View style={{ minWidth: 62 }}>
        <SkeletonTextLine width={50} barHeight={13} boxHeight={18} />
      </View>
      <View style={{ flex: 1, gap: 5 }}>
        <SkeletonTextLine width="58%" barHeight={13} boxHeight={18} />
        <SkeletonTextLine width="84%" barHeight={11} boxHeight={16} />
      </View>
    </View>
  );
}
