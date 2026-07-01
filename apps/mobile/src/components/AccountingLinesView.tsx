import { View, Text } from 'react-native';
import { formatEUR } from '@bob/core';
import { useTheme } from '../theme';
import { font } from './ui';

/** Ligne d'écriture (forme structurelle commune à ActionDiff.AccountingLine et AccountingPreviewLine). */
export interface LedgerLine {
  readonly account: string;
  readonly label: string;
  readonly debitCents: number;
  readonly creditCents: number;
}

/**
 * Rend une écriture comptable en partie double : « compte · libellé  →  D montant / C montant », avec un
 * total débit/crédit optionnel. Partagé par l'aperçu d'action (ActionDiffView) et le détail facture émise.
 */
export function AccountingLinesView({
  lines,
  totalDebitCents,
  totalCreditCents,
}: {
  lines: readonly LedgerLine[];
  totalDebitCents?: number;
  totalCreditCents?: number;
}) {
  const { colors } = useTheme();
  if (!lines.length) return null;
  const showTotals = typeof totalDebitCents === 'number' && typeof totalCreditCents === 'number';
  return (
    <View style={{ gap: 4 }}>
      {lines.map((l, i) => {
        const debit = l.debitCents > 0;
        return (
          <View key={`${l.account}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[font('sub'), { color: colors.ink800, flex: 1, paddingRight: 8 }]} numberOfLines={1}>
              {l.account} · {l.label}
            </Text>
            <Text style={[font('sub'), { color: debit ? colors.ink900 : colors.slate500 }]}>
              {debit ? `D ${formatEUR(l.debitCents)}` : `C ${formatEUR(l.creditCents)}`}
            </Text>
          </View>
        );
      })}
      {showTotals ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: 4,
            paddingTop: 6,
            borderTopWidth: 1,
            borderTopColor: colors.lineSoft,
          }}
        >
          <Text style={[font('meta'), { color: colors.slate400 }]}>Total</Text>
          <Text style={[font('meta'), { color: colors.slate500 }]}>
            D {formatEUR(totalDebitCents!)} · C {formatEUR(totalCreditCents!)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
