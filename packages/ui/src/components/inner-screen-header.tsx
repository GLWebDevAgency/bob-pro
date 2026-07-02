/**
 * InnerScreenHeader — §3 (Argent / Clients / Documents / Assistant).
 * En-tête clair : eyebrow slate400 uppercase → titre pageTitle ink800 → sous-titre 14.5 slate500.
 * L'accueil est le SEUL en-tête dégradé ; ici, fond clair (hérité de l'écran).
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { patterns } from '@bob/tokens';
import { font, useTheme } from '../theme';

export interface InnerScreenHeaderProps {
  eyebrow: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}

export function InnerScreenHeader({ eyebrow, title, subtitle, action }: InnerScreenHeaderProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.root}>
      <View style={styles.texts}>
        <Text style={[font('eyebrow'), { color: colors.slate400 }]} accessibilityRole="text">
          {eyebrow}
        </Text>
        <Text
          style={[font('pageTitle'), styles.title, { color: colors.ink800 }]}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={[font('body'), styles.subtitle, { color: colors.slate500 }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {action !== undefined ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingTop: patterns.innerScreenHeader.paddingTop,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  texts: { flex: 1 },
  title: { marginTop: 4 },
  subtitle: { marginTop: 4 },
  action: { marginLeft: 12 },
});
