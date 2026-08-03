/**
 * PieceListRow — rangée de pièce de vente (Lot 3, plan DA 01/08 « 1er commit du lot ») :
 * titre (n°) + client + méta (dates) + chips liées à gauche ; montant + statut à droite.
 * CONSOMMÉE par les cartes devis ET factures de ventes.tsx (verdict PR #61, P3 : une seule
 * source de vérité pour la rangée — plus de gabarit inline dupliqué) ; resservira à la
 * recherche. Montant/badge/chips sont INJECTÉS (MoneyText, StatusBadge…) : la rangée fige
 * la géométrie, jamais la sémantique. Seule différence assumée vs l'inline historique :
 * une ligne de dates VIDE ne rend plus un nœud Text fantôme (meta '' est masqué).
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { font, useTheme } from '../theme';

export interface PieceListRowProps {
  /** N° de pièce (ou « Brouillon ») — cardTitle ink900. */
  readonly title: string;
  /** Nom du client — meta slate400. */
  readonly subtitle: string;
  /** Ligne de dates (émise le · échéance…) — meta slate400. */
  readonly meta?: string;
  /** Rangée de chips liées (kind, avoir émis, devis parent…) — rendue sous les métas. */
  readonly chips?: ReactNode;
  /** Montant héros de la rangée (MoneyText côté appelant — netToPay, règle acompte). */
  readonly amount: ReactNode;
  /** Sous le montant : « À encaisser … » (optionnel). */
  readonly belowAmount?: ReactNode;
  /** Badge de statut (StatusBadge via la table de mapping figée). */
  readonly status: ReactNode;
  readonly onPress: () => void;
  readonly accessibilityLabel: string;
  readonly testID?: string;
}

export function PieceListRow({
  title,
  subtitle,
  meta,
  chips,
  amount,
  belowAmount,
  status,
  onPress,
  accessibilityLabel,
  testID,
}: PieceListRowProps) {
  const { colors } = useTheme();
  return (
    <Pressable
      {...(testID !== undefined ? { testID } : {})}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <View style={{ flex: 1, paddingRight: 12 }}>
        <Text style={[font('cardTitle'), { color: colors.ink900 }]}>{title}</Text>
        <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{subtitle}</Text>
        {meta !== undefined && meta !== '' ? (
          <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{meta}</Text>
        ) : null}
        {chips}
      </View>
      <View style={{ alignItems: 'flex-end', gap: 6 }}>
        {amount}
        {belowAmount}
        {status}
      </View>
    </Pressable>
  );
}
