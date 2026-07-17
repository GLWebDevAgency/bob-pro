/**
 * B9 — chips de dates de l'écran Ventes : Ce mois-ci / Mois dernier / 2 derniers mois /
 * Personnalisé. Les 3 presets viennent de @bob/core (thisMonthRange/lastMonthRange/
 * lastNMonthsRange) — SEULE source de vérité, partagée avec le parseur vocal
 * (parseFrenchPeriod) pour que la chip et « le mois dernier » dit à voix haute pointent
 * TOUJOURS vers la même plage. « Personnalisé » ouvre deux champs JJ/MM/AAAA sobres (aucune
 * lib de calendrier dans ce monorepo — cf. inventaire) plutôt qu'une roue ou un calendrier
 * plein écran, en cohérence avec le reste de l'écran (recherche.tsx, chantiers.tsx).
 */
import { useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { isValidDateOnly, lastMonthRange, lastNMonthsRange, thisMonthRange, type DateOnly } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { useTheme } from '@bob/ui';
import { Chip, font } from './ui';

export type DatePresetKey = 'thisMonth' | 'lastMonth' | 'last2Months' | 'custom';

export interface DateRangeValue {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly preset: DatePresetKey;
}

/** "YYYY-MM-DD" -> "JJ/MM/AAAA" (affichage humain FR uniquement — jamais reparsé). */
function toFrDisplay(date: DateOnly): string {
  const [y, m, d] = date.split('-');
  return d && m && y ? `${d}/${m}/${y}` : date;
}

/** "JJ/MM/AAAA" tapé -> "YYYY-MM-DD", ou null tant que la saisie est incomplète/invalide. */
function fromFrInput(raw: string): DateOnly | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw.trim());
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  const candidate = `${m[3]}-${m[2]}-${m[1]}`;
  return isValidDateOnly(candidate) ? candidate : null;
}

/** Masque de saisie JJ/MM/AAAA au fil de la frappe (numérique, slashs auto-insérés). */
function maskFrDate(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const day = digits.slice(0, 2);
  const month = digits.slice(2, 4);
  const year = digits.slice(4, 8);
  return [day, month, year].filter((part) => part.length > 0).join('/');
}

export function DateRangeChips({
  value,
  onChange,
  today,
}: {
  readonly value: DateRangeValue | null;
  readonly onChange: (next: DateRangeValue | null) => void;
  readonly today: DateOnly;
}) {
  const { colors, semantic, personality } = useTheme();
  const [customOpen, setCustomOpen] = useState(false);
  const [fromInput, setFromInput] = useState(value?.preset === 'custom' ? toFrDisplay(value.from) : '');
  const [toInput, setToInput] = useState(value?.preset === 'custom' ? toFrDisplay(value.to) : '');
  const [customError, setCustomError] = useState<string | null>(null);

  const presets: { key: DatePresetKey; labelKey: I18nKey; range: () => { from: DateOnly; to: DateOnly } }[] = [
    { key: 'thisMonth', labelKey: 'ventes.dateChip.thisMonth', range: () => thisMonthRange(today) },
    { key: 'lastMonth', labelKey: 'ventes.dateChip.lastMonth', range: () => lastMonthRange(today) },
    { key: 'last2Months', labelKey: 'ventes.dateChip.last2Months', range: () => lastNMonthsRange(today, 2) },
  ];

  const selectPreset = (key: DatePresetKey, range: { from: DateOnly; to: DateOnly }) => {
    setCustomOpen(false);
    setCustomError(null);
    if (value?.preset === key) {
      onChange(null);
      return;
    }
    onChange({ ...range, preset: key });
  };

  const applyCustom = () => {
    const from = fromFrInput(fromInput);
    const to = fromFrInput(toInput);
    if (from === null || to === null) {
      setCustomError(t('ventes.advancedSearch.dateFrom', { personality }) + ' / ' + t('ventes.advancedSearch.dateTo', { personality }));
      return;
    }
    if (from > to) {
      setCustomError(null);
      onChange({ from: to, to: from, preset: 'custom' });
      return;
    }
    setCustomError(null);
    onChange({ from, to, preset: 'custom' });
  };

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {presets.map(({ key, labelKey, range }) => (
          <Chip
            key={key}
            label={t(labelKey, { personality })}
            active={value?.preset === key}
            onPress={() => selectPreset(key, range())}
          />
        ))}
        <Chip
          label={
            value?.preset === 'custom'
              ? t('ventes.dateChip.customRange', {
                  personality,
                  params: { from: toFrDisplay(value.from), to: toFrDisplay(value.to) },
                })
              : t('ventes.dateChip.custom', { personality })
          }
          active={value?.preset === 'custom'}
          onPress={() => {
            if (value?.preset === 'custom') {
              onChange(null);
              setCustomOpen(false);
              return;
            }
            setCustomOpen((open) => !open);
          }}
        />
      </View>
      {customOpen ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
              {t('ventes.advancedSearch.dateFrom', { personality })}
            </Text>
            <TextInput
              value={fromInput}
              onChangeText={(raw) => setFromInput(maskFrDate(raw))}
              placeholder="JJ/MM/AAAA"
              placeholderTextColor={colors.slate300}
              keyboardType="number-pad"
              maxLength={10}
              accessibilityLabel={t('ventes.advancedSearch.dateFrom', { personality })}
              style={[font('body'), { minHeight: 40, color: colors.ink900, borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 10 }]}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
              {t('ventes.advancedSearch.dateTo', { personality })}
            </Text>
            <TextInput
              value={toInput}
              onChangeText={(raw) => setToInput(maskFrDate(raw))}
              placeholder="JJ/MM/AAAA"
              placeholderTextColor={colors.slate300}
              keyboardType="number-pad"
              maxLength={10}
              accessibilityLabel={t('ventes.advancedSearch.dateTo', { personality })}
              style={[font('body'), { minHeight: 40, color: colors.ink900, borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 10 }]}
            />
          </View>
          <Chip label={t('ventes.advancedSearch.submit', { personality })} onPress={applyCustom} />
        </View>
      ) : null}
      {customError ? (
        <Text accessibilityRole="alert" style={[font('meta'), { color: semantic.danger }]}>
          {customError}
        </Text>
      ) : null}
    </View>
  );
}
