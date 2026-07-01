import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ActionDiff } from '@bob/ai';
import { useTheme } from '../theme';
import { font } from './ui';

/**
 * Rend un ActionDiff (aperçu avant → après) sous forme de lignes « libellé : avant → après ».
 * Présentation partagée par la ConfirmSheet (flux manuel) et l'assistant vocal (aperçu inline).
 */
export function ActionDiffView({ diff }: { diff: ActionDiff | null | undefined }) {
  const { colors } = useTheme();
  if (!diff || diff.fields.length === 0) return null;
  return (
    <View
      style={{ marginTop: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.lineSoft, padding: 12, gap: 8 }}
    >
      {diff.fields.map((f) => (
        <View key={f.label} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[font('meta'), { color: colors.slate400 }]}>{f.label}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={[font('sub'), { color: colors.slate500 }]}>{f.before}</Text>
            <Ionicons name="arrow-forward" size={13} color={colors.slate400} />
            <Text style={[font('sub'), { color: colors.ink900 }]}>{f.after}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}
