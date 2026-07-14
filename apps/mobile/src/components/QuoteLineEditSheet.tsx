/**
 * QuoteLineEditSheet (R6) — édition d'une ligne de devis BROUILLON, ouverte par le swipe
 * (Modifier) ou par une affordance vocale (« modifie la deuxième ligne, mets 3 heures » —
 * R7 : la voix PRÉPARE les champs visibles, seul le tap sur Enregistrer écrit). Champs repris
 * du formulaire de ligne de devis/new.tsx (label/qté/PU/TVA) pour une expérience cohérente.
 */
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { VAT_RATES, type PieceLineView, type VatRate } from '@bob/core';
import { t } from '@bob/i18n';
import { Button, Chip, Sheet, font, useTheme } from '@bob/ui';

export interface QuoteLineEditPatch {
  readonly label: string;
  readonly qty: number;
  readonly unitPriceHT: number;
  readonly vatRate: VatRate;
}

/** R7 : valeurs déjà extraites de l'énoncé vocal (préremplissage) — le tap reste requis. */
export interface QuoteLineEditSeed {
  readonly qty?: number;
  readonly unitPriceHT?: number;
}

export interface QuoteLineEditSheetProps {
  readonly visible: boolean;
  readonly line: PieceLineView | null;
  readonly seed?: QuoteLineEditSeed | null;
  readonly saving?: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (patch: QuoteLineEditPatch) => void;
}

const fmtRate = (rate: number): string => String(rate).replace('.', ',');

function parseDecimal(value: string): number | null {
  const n = Number(value.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const fieldStyle = (colors: { ink900: string; line: string }) => [
  font('body'),
  {
    minHeight: 44,
    color: colors.ink900,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
];

export function QuoteLineEditSheet({ visible, line, seed, saving = false, onClose, onSubmit }: QuoteLineEditSheetProps) {
  const { personality, colors } = useTheme();
  const [label, setLabel] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [vatRate, setVatRate] = useState<VatRate>(20);

  // Réamorce les champs à chaque ouverture (ou changement de ligne/seed vocal) — jamais un
  // résidu d'une édition précédente.
  useEffect(() => {
    if (!visible || !line) return;
    setLabel(line.label);
    setQty(String(seed?.qty ?? line.qty));
    setPrice(((seed?.unitPriceHT ?? line.unitPriceHTCents) / 100).toFixed(2).replace('.', ','));
    setVatRate(line.vatRatePct as VatRate);
  }, [visible, line, seed]);

  const qtyValue = parseDecimal(qty);
  const priceValue = parseDecimal(price);
  const valid = label.trim() !== '' && qtyValue !== null && priceValue !== null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={t('devis.lineEditTitle', { personality })}
      closeAccessibilityLabel={t('piece.close', { personality })}
    >
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12 }]}>
        {t('devis.lineEditTitle', { personality })}
      </Text>
      <TextInput
        value={label}
        onChangeText={setLabel}
        placeholder={t('devis.lineLabelPlaceholder', { personality })}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={t('devis.lineLabelPlaceholder', { personality })}
        style={[...fieldStyle(colors), { marginBottom: 10 }]}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ width: 92 }}>
          <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
            {t('devis.qtyLabel', { personality })}
          </Text>
          <TextInput
            value={qty}
            onChangeText={setQty}
            keyboardType="decimal-pad"
            accessibilityLabel={t('devis.qtyLabel', { personality })}
            style={fieldStyle(colors)}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
            {t('devis.unitPriceLabel', { personality })}
          </Text>
          <TextInput
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            placeholder="0,00"
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('devis.unitPriceLabel', { personality })}
            style={fieldStyle(colors)}
          />
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {VAT_RATES.map((rate) => (
          <Chip key={rate} label={`TVA ${fmtRate(rate)} %`} active={vatRate === rate} onPress={() => setVatRate(rate)} />
        ))}
      </View>
      <View style={{ marginTop: 16 }}>
        <Button
          title={t('devis.lineEditSave', { personality })}
          loading={saving}
          disabled={!valid || saving}
          onPress={() => {
            if (!valid || qtyValue === null || priceValue === null) return;
            onSubmit({ label: label.trim(), qty: qtyValue, unitPriceHT: Math.round(priceValue * 100), vatRate });
          }}
        />
      </View>
    </Sheet>
  );
}
