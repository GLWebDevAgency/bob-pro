import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { formatEUR } from '@bob/core';
import type { ActionDiff } from '@bob/ai';
import { useTheme } from '../theme';
import { font } from './ui';

/**
 * Rend un ActionDiff (aperçu avant → après) sous forme de lignes « libellé : avant → après », plus, si
 * présente, l'écriture comptable (débit/crédit). Présentation partagée par la ConfirmSheet (flux manuel)
 * et l'assistant vocal (aperçu inline).
 */
export function ActionDiffView({ diff }: { diff: ActionDiff | null | undefined }) {
  const { colors } = useTheme();
  if (!diff || (diff.fields.length === 0 && !diff.accounting?.length)) return null;
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

      {diff.accounting && diff.accounting.length > 0 ? (
        <View style={{ marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.lineSoft, gap: 4 }}>
          <Text style={[font('meta'), { color: colors.slate400 }]}>Écriture comptable</Text>
          {diff.accounting.map((l, i) => {
            const debit = l.debitCents > 0;
            return (
              <View key={`${l.account}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <Text style={[font('sub'), { color: colors.ink800 }]} numberOfLines={1}>
                  {l.account} · {l.label}
                </Text>
                <Text style={[font('sub'), { color: debit ? colors.ink900 : colors.slate500 }]}>
                  {debit ? `D ${formatEUR(l.debitCents)}` : `C ${formatEUR(l.creditCents)}`}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
