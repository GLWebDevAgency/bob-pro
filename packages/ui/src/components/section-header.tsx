/**
 * SectionHeader — en-tête de bloc (échelle `section` : 17/700, ink800) + action optionnelle.
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { useTheme, font } from '../theme';

export interface SectionHeaderProps {
  title: string;
  /** Action de droite injectée (lien « Tout voir », bouton…). */
  action?: ReactNode;
}

export function SectionHeader({ title, action }: SectionHeaderProps) {
  const { colors } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 13,
      }}
    >
      <Text accessibilityRole="header" style={[font('section'), { color: colors.ink800 }]}>
        {title}
      </Text>
      {action}
    </View>
  );
}
