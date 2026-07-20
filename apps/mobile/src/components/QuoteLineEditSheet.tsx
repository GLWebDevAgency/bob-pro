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
import {
  isValidQuoteLineLabel,
  parseQuoteLineEuroCents,
  parseQuoteLineQuantity,
} from './quote-line-edit.logic';

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
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly onDelete?: () => void;
  readonly onInputChange?: () => void;
  readonly onSubmit: (patch: QuoteLineEditPatch) => void;
}

const fmtRate = (rate: number): string => String(rate).replace('.', ',');

const fieldStyle = (colors: { ink900: string; line: string }, danger: string, invalid: boolean) => [
  font('body'),
  {
    minHeight: 44,
    color: colors.ink900,
    borderWidth: 1,
    borderColor: invalid ? danger : colors.line,
    borderRadius: 12,
    paddingHorizontal: 12,
  },
];

export function QuoteLineEditSheet({
  visible,
  line,
  seed,
  saving = false,
  error = null,
  onClose,
  onDelete,
  onInputChange,
  onSubmit,
}: QuoteLineEditSheetProps) {
  const { personality, colors, semantic } = useTheme();
  const [label, setLabel] = useState('');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [vatRate, setVatRate] = useState<VatRate>(20);
  const [touched, setTouched] = useState({ label: false, qty: false, price: false });

  // Réamorce les champs à chaque ouverture (ou changement de ligne/seed vocal) — jamais un
  // résidu d'une édition précédente.
  useEffect(() => {
    if (!visible || !line) return;
    setLabel(line.label);
    setQty(String(seed?.qty ?? line.qty));
    setPrice(((seed?.unitPriceHT ?? line.unitPriceHTCents) / 100).toFixed(2).replace('.', ','));
    setVatRate(line.vatRatePct as VatRate);
    setTouched({ label: false, qty: false, price: false });
  }, [visible, line, seed]);

  const labelValid = isValidQuoteLineLabel(label);
  const qtyValue = parseQuoteLineQuantity(qty);
  const priceCents = parseQuoteLineEuroCents(price);
  const valid = labelValid && qtyValue !== null && priceCents !== null;
  const markTouched = (field: keyof typeof touched): void => {
    setTouched((current) => ({ ...current, [field]: true }));
    onInputChange?.();
  };

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
        onChangeText={(value) => {
          setLabel(value);
          markTouched('label');
        }}
        onBlur={() => setTouched((current) => ({ ...current, label: true }))}
        maxLength={500}
        placeholder={t('devis.lineLabelPlaceholder', { personality })}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={t('devis.lineLabelPlaceholder', { personality })}
        accessibilityHint={t('devis.lineEditLabelHint', { personality })}
        style={[...fieldStyle(colors, semantic.danger, touched.label && !labelValid), { marginBottom: 10 }]}
      />
      {touched.label && !labelValid ? (
        <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.danger, marginTop: -6, marginBottom: 8 }]}>
          {t('devis.lineEditLabelError', { personality })}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 0.8, minWidth: 100 }}>
          <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
            {t('devis.qtyLabel', { personality })}
          </Text>
          <TextInput
            value={qty}
            onChangeText={(value) => {
              setQty(value);
              markTouched('qty');
            }}
            onBlur={() => setTouched((current) => ({ ...current, qty: true }))}
            keyboardType="decimal-pad"
            accessibilityLabel={t('devis.qtyLabel', { personality })}
            accessibilityHint={t('devis.lineEditQtyHint', { personality })}
            style={fieldStyle(colors, semantic.danger, touched.qty && qtyValue === null)}
          />
          {touched.qty && qtyValue === null ? (
            <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.danger, marginTop: 4 }]}>
              {t('devis.lineEditQtyError', { personality })}
            </Text>
          ) : null}
        </View>
        <View style={{ flex: 1.2, minWidth: 128 }}>
          <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
            {t('devis.unitPriceLabel', { personality })}
          </Text>
          <TextInput
            value={price}
            onChangeText={(value) => {
              setPrice(value);
              markTouched('price');
            }}
            onBlur={() => setTouched((current) => ({ ...current, price: true }))}
            keyboardType="decimal-pad"
            placeholder="0,00"
            placeholderTextColor={colors.slate400}
            accessibilityLabel={t('devis.unitPriceLabel', { personality })}
            accessibilityHint={t('devis.lineEditPriceHint', { personality })}
            style={fieldStyle(colors, semantic.danger, touched.price && priceCents === null)}
          />
          {touched.price && priceCents === null ? (
            <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.danger, marginTop: 4 }]}>
              {t('devis.lineEditPriceError', { personality })}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {VAT_RATES.map((rate) => (
          <Chip
            key={rate}
            label={`TVA ${fmtRate(rate)} %`}
            active={vatRate === rate}
            onPress={() => {
              setVatRate(rate);
              onInputChange?.();
            }}
          />
        ))}
      </View>
      {error ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginTop: 12, borderRadius: 12, padding: 10, backgroundColor: semantic.dangerBg }}
        >
          <Text style={[font('meta', 600), { color: semantic.danger }]}>{error}</Text>
        </View>
      ) : null}
      <View style={{ marginTop: 16 }}>
        <Button
          title={t('devis.lineEditSave', { personality })}
          loading={saving}
          disabled={!valid || saving}
          onPress={() => {
            if (!valid || qtyValue === null || priceCents === null) return;
            onSubmit({ label: label.trim(), qty: qtyValue, unitPriceHT: priceCents, vatRate });
          }}
        />
      </View>
      {onDelete ? (
        <View style={{ marginTop: 8 }}>
          <Button
            title={t('devis.lineEditDelete', { personality })}
            variant="danger"
            disabled={saving}
            onPress={onDelete}
          />
        </View>
      ) : null}
    </Sheet>
  );
}
