/**
 * EMPTY STATE & ERROR RETRY — le socle des états sans données et d'échec (audit 14/07,
 * passe feel 18/07).
 *
 * DOCTRINE :
 * · EmptyState se place DANS la Card appelante (jamais une Card à part qui casse le rythme),
 *   sans icône par défaut — la voix de Bob suffit. Corps obligatoire, titre et CTA optionnels
 *   (le CTA UNIQUEMENT pour un vrai cul-de-sac de flux, ex. « Ajouter un client »).
 *   Pour les vides « premier pas » des écrans majeurs, une icône injectée peut coiffer le
 *   titre dans une tuile pastel (IconTile) — hiérarchie tuile → titre → corps → CTA,
 *   espacements généreux ; jamais une décoration sur un simple filtre vide.
 * · ErrorRetry : un ÉCHEC n'est JAMAIS présenté comme une absence de données (classe de bug
 *   P0 dominante de l'audit). Message honnête + « Réessayer » toujours ; action secondaire
 *   pour les culs-de-sac (fermer l'écran).
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { font, useTheme } from '../theme';
import { Button } from './button';
import { Card } from './card';
import { IconTile } from './icon-tile';
import type { StatusBadgeVariant } from './status-badge.logic';

export interface EmptyStateProps {
  /** La phrase utile — jamais « aucune donnée » sec : dire QUOI faire ou POURQUOI c'est vide. */
  body: string;
  title?: string;
  /** Icône 16-18 injectée (stroke 2) — coiffe le titre dans une tuile pastel. Réservée aux
   *  vides « premier pas » des écrans majeurs, pas aux filtres momentanément vides. */
  icon?: ReactNode;
  /** Teinte pastel de la tuile d'icône (défaut success — un vide d'onboarding est un début). */
  iconTone?: StatusBadgeVariant;
  /** Réservé aux vrais culs-de-sac de flux — pas un upsell, pas une décoration. */
  cta?: { label: string; onPress: () => void };
}

export function EmptyState({ body, title, icon, iconTone = 'success', cta }: EmptyStateProps) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="text">
      {icon !== undefined ? (
        <View style={{ marginBottom: 12 }}>
          <IconTile tone={iconTone} size={34} radius={11}>
            {icon}
          </IconTile>
        </View>
      ) : null}
      {title !== undefined ? (
        <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 6 }]}>{title}</Text>
      ) : null}
      <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>{body}</Text>
      {cta !== undefined ? (
        <View style={{ marginTop: 14, alignSelf: 'flex-start' }}>
          <Button title={cta.label} variant="secondary" onPress={cta.onPress} />
        </View>
      ) : null}
    </View>
  );
}

export interface ErrorRetryProps {
  /** Message honnête : ce qui a échoué, en français humain — jamais un code. */
  message: string;
  onRetry: () => void;
  /** Tentative manuelle EN COURS : spinner + bouton neutralisé — l'utilisateur voit que ça
   *  travaille (montée d'exigence 16/07), et un double-tap ne déclenche jamais deux refetchs. */
  retrying?: boolean;
  /** Sortie de secours pour un écran-pièce (fermer) — jamais un utilisateur piégé. */
  secondaryLabel?: string;
  onSecondaryAction?: () => void;
}

export function ErrorRetry({
  message,
  onRetry,
  retrying = false,
  secondaryLabel,
  onSecondaryAction,
}: ErrorRetryProps) {
  const { colors, semantic } = useTheme();
  return (
    <Card style={{ borderColor: semantic.danger, borderWidth: 1 }}>
      <Text accessibilityRole="alert" style={[font('sub'), { color: colors.ink900, lineHeight: 20 }]}>
        {message}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <Button title="Réessayer" variant="secondary" onPress={onRetry} loading={retrying} />
        {onSecondaryAction && secondaryLabel ? (
          <Button title={secondaryLabel} variant="secondary" onPress={onSecondaryAction} />
        ) : null}
      </View>
    </Card>
  );
}
