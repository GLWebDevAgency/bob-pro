import { Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ActionDiff } from '@bob/ai';
import { font, useTheme } from '@bob/ui';
import { AccountingLinesView } from './AccountingLinesView';

/**
 * Rend un ActionDiff (aperçu avant → après) sous forme de lignes lisibles à toute taille de texte,
 * plus, si présente, l'écriture comptable. La sémantique « avant / après » est explicite pour les
 * lecteurs d'écran ; la flèche reste strictement décorative.
 */
export function ActionDiffView({ diff }: { diff: ActionDiff | null | undefined }) {
  const { colors } = useTheme();
  if (!diff || (diff.fields.length === 0 && !diff.accounting?.length)) return null;

  return (
    <View
      style={{
        marginTop: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.line,
        padding: 12,
        gap: 10,
      }}
    >
      {diff.fields.map((field, index) => (
        <View
          key={`${field.label}-${index}`}
          accessible
          accessibilityLabel={`${field.label}. Avant : ${field.before}. Après : ${field.after}.`}
          style={{ gap: 4 }}
        >
          <Text
            accessible={false}
            style={[font('meta'), { color: colors.slate500, lineHeight: 18 }]}
          >
            {field.label}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <Text
              accessible={false}
              style={[
                font('sub'),
                { color: colors.slate500, lineHeight: 20, textDecorationLine: 'line-through' },
              ]}
            >
              {field.before}
            </Text>
            <Ionicons
              accessible={false}
              importantForAccessibility="no"
              name="arrow-forward"
              size={14}
              color={colors.slate500}
            />
            <Text
              accessible={false}
              style={[font('sub', 600), { color: colors.ink900, lineHeight: 20 }]}
            >
              {field.after}
            </Text>
          </View>
        </View>
      ))}

      {diff.accounting && diff.accounting.length > 0 ? (
        <View
          style={{
            marginTop: 2,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: colors.line,
            gap: 6,
          }}
        >
          <Text
            accessibilityRole="header"
            style={[font('meta'), { color: colors.ink800, lineHeight: 18 }]}
          >
            Écriture comptable
          </Text>
          <AccountingLinesView lines={diff.accounting} />
        </View>
      ) : null}
    </View>
  );
}
