import { Text, View } from 'react-native';
import { font, useTheme } from '@bob/ui';
import { type Personality } from '@bob/i18n';
import { FileTextIcon, CameraIcon } from './icons';
import {
  chantierRowCountsAccessibilityLabel,
  visibleChantierRowCounts,
  type ChantierRowCounts,
} from './chantier-row-counts.logic';

/**
 * Compteurs sobres icône + nombre sur une rangée de liste de chantiers (fiche client onglet
 * Chantiers/Projets ET écran standalone /chantiers) — RIEN si les deux compteurs sont à 0, jamais
 * de puce fantôme. Un seul groupe accessible porte le libellé complet (« 3 notes, 1 photo ») pour
 * les lecteurs d'écran ; les puces visuelles ne montrent qu'une icône + un nombre.
 */
export function ChantierRowCountBadges({
  counts,
  personality,
}: {
  counts: ChantierRowCounts;
  personality: Personality;
}) {
  const { colors } = useTheme();
  const { noteCount, photoCount } = visibleChantierRowCounts(counts);
  if (noteCount === 0 && photoCount === 0) return null;
  const label = chantierRowCountsAccessibilityLabel(counts, personality);

  return (
    <View
      accessible
      accessibilityLabel={label ?? undefined}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 5 }}
    >
      {noteCount > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <FileTextIcon color={colors.slate400} size={12} strokeWidth={2} />
          <Text style={[font('meta'), { fontSize: 11, color: colors.slate400 }]}>{noteCount}</Text>
        </View>
      ) : null}
      {photoCount > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          <CameraIcon color={colors.slate400} size={12} strokeWidth={2} />
          <Text style={[font('meta'), { fontSize: 11, color: colors.slate400 }]}>{photoCount}</Text>
        </View>
      ) : null}
    </View>
  );
}
