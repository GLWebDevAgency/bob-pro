import { Text, View } from 'react-native';
import { formatEUR } from '@bob/core';
import { font, useTheme } from '@bob/ui';

/** Ligne d'écriture (forme structurelle commune à ActionDiff.AccountingLine et AccountingPreviewLine). */
export interface LedgerLine {
  readonly account: string;
  readonly label: string;
  readonly debitCents: number;
  readonly creditCents: number;
}

interface AccountingLinesViewProps {
  readonly lines: readonly LedgerLine[];
  readonly totalDebitCents?: number;
  readonly totalCreditCents?: number;
}

/**
 * Rend une écriture en partie double. Les lignes se replient au lieu de tronquer le compte ou le
 * libellé ; les abréviations visuelles D/C sont annoncées « Débit/Crédit » par les lecteurs d'écran.
 */
export function AccountingLinesView({
  lines,
  totalDebitCents,
  totalCreditCents,
}: AccountingLinesViewProps) {
  const { colors } = useTheme();
  if (lines.length === 0) return null;

  const totals =
    typeof totalDebitCents === 'number' && typeof totalCreditCents === 'number'
      ? { debitCents: totalDebitCents, creditCents: totalCreditCents }
      : null;

  return (
    <View style={{ gap: 7 }}>
      {lines.map((line, index) => {
        const debit = line.debitCents > 0;
        const amountCents = debit ? line.debitCents : line.creditCents;
        const side = debit ? 'Débit' : 'Crédit';
        const shortSide = debit ? 'D' : 'C';
        return (
          <View
            key={`${line.account}-${index}`}
            accessible
            accessibilityLabel={`${line.account}, ${line.label}. ${side} : ${formatEUR(amountCents)}.`}
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              columnGap: 10,
              rowGap: 2,
            }}
          >
            <Text
              accessible={false}
              style={[
                font('sub'),
                {
                  color: colors.ink800,
                  flexGrow: 1,
                  flexShrink: 1,
                  minWidth: 150,
                  lineHeight: 20,
                },
              ]}
            >
              {line.account} · {line.label}
            </Text>
            <Text
              accessible={false}
              style={[
                font('sub', 600),
                {
                  color: debit ? colors.ink900 : colors.slate500,
                  lineHeight: 20,
                  fontVariant: ['tabular-nums'],
                },
              ]}
            >
              {shortSide} {formatEUR(amountCents)}
            </Text>
          </View>
        );
      })}

      {totals !== null ? (
        <View
          accessible
          accessibilityLabel={`Total. Débit : ${formatEUR(totals.debitCents)}. Crédit : ${formatEUR(totals.creditCents)}.`}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            columnGap: 10,
            rowGap: 2,
            marginTop: 3,
            paddingTop: 8,
            borderTopWidth: 1,
            borderTopColor: colors.line,
          }}
        >
          <Text accessible={false} style={[font('meta'), { color: colors.ink800, lineHeight: 18 }]}>
            Total
          </Text>
          <Text
            accessible={false}
            style={[
              font('meta'),
              { color: colors.slate500, lineHeight: 18, fontVariant: ['tabular-nums'] },
            ]}
          >
            D {formatEUR(totals.debitCents)} · C {formatEUR(totals.creditCents)}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
