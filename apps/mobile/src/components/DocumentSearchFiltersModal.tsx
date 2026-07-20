/**
 * B9 — modale de recherche avancée (bouton en bout du champ Ventes) : client (liste
 * cherchable), numéro, prestation/libellé, plage de dates, statut. « Rechercher » applique
 * TOUT d'un coup et ferme ; state local tant que non appliqué (Annuler ne mute rien).
 */
import { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { t } from '@bob/i18n';
import { Button, Sheet, font, useTheme } from '@bob/ui';
import type { DateOnly } from '@bob/core';
import { Chip } from './ui';
import { DateRangeChips, type DateRangeValue } from './DateRangeChips';

export interface AdvancedSearchFilters {
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly number: string;
  readonly label: string;
  readonly dateRange: DateRangeValue | null;
  readonly status: string | null;
}

export const EMPTY_ADVANCED_FILTERS: AdvancedSearchFilters = {
  customerId: null,
  customerName: null,
  number: '',
  label: '',
  dateRange: null,
  status: null,
};

export function DocumentSearchFiltersModal({
  visible,
  onClose,
  onApply,
  initial,
  customers,
  statusOptions,
  today,
}: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onApply: (filters: AdvancedSearchFilters) => void;
  readonly initial: AdvancedSearchFilters;
  readonly customers: readonly { id: string; name: string }[];
  /** Vide si kindFilter === 'all' (statuts Devis/Facture non comparables — cf. ventes.tsx). */
  readonly statusOptions: readonly { value: string; label: string }[];
  readonly today: DateOnly;
}) {
  const { colors, personality } = useTheme();
  const [customerId, setCustomerId] = useState(initial.customerId);
  const [customerName, setCustomerName] = useState(initial.customerName);
  const [customerQuery, setCustomerQuery] = useState('');
  const [number, setNumber] = useState(initial.number);
  const [label, setLabel] = useState(initial.label);
  const [dateRange, setDateRange] = useState<DateRangeValue | null>(initial.dateRange);
  const [status, setStatus] = useState(initial.status);

  const filteredCustomers = useMemo(() => {
    const q = customerQuery.trim().toLowerCase();
    if (q === '') return customers.slice(0, 6);
    return customers.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6);
  }, [customers, customerQuery]);

  const reset = (): void => {
    setCustomerId(null);
    setCustomerName(null);
    setCustomerQuery('');
    setNumber('');
    setLabel('');
    setDateRange(null);
    setStatus(null);
  };

  const submit = (): void => {
    onApply({ customerId, customerName, number: number.trim(), label: label.trim(), dateRange, status });
    onClose();
  };

  const fieldStyle = [
    font('body'),
    {
      minHeight: 44,
      borderWidth: 1,
      borderColor: colors.lineSoft,
      borderRadius: 12,
      paddingHorizontal: 13,
      paddingVertical: 11,
      color: colors.ink800,
      marginTop: 7,
    },
  ];

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={t('ventes.advancedSearch.title', { personality })}
      closeAccessibilityLabel={t('ventes.advancedSearch.cancel', { personality })}
    >
      <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 520 }}>
          <Text style={[font('pageTitle'), { fontSize: 20, color: colors.ink900 }]}>
            {t('ventes.advancedSearch.title', { personality })}
          </Text>
          <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19, marginTop: 4 }]}>
            {t('ventes.advancedSearch.subtitle', { personality })}
          </Text>

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 16 }]}>
            {t('ventes.advancedSearch.fieldCustomer', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={customerId !== null ? (customerName ?? '') : customerQuery}
            onChangeText={(text) => {
              setCustomerId(null);
              setCustomerName(null);
              setCustomerQuery(text);
            }}
            placeholder={t('ventes.advancedSearch.customerPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('ventes.advancedSearch.fieldCustomer', { personality })}
            style={fieldStyle}
          />
          {customerId === null && customerQuery.trim().length > 0 ? (
            <View style={{ marginTop: 4 }}>
              {filteredCustomers.map((c) => (
                <Pressable
                  key={c.id}
                  accessibilityRole="button"
                  accessibilityLabel={c.name}
                  onPress={() => {
                    setCustomerId(c.id);
                    setCustomerName(c.name);
                    setCustomerQuery('');
                  }}
                  style={{ minHeight: 40, justifyContent: 'center', paddingHorizontal: 4 }}
                >
                  <Text style={[font('sub'), { color: colors.ink800 }]}>{c.name}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 14 }]}>
            {t('ventes.advancedSearch.fieldNumber', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={number}
            onChangeText={setNumber}
            placeholder={t('ventes.advancedSearch.numberPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            autoCapitalize="characters"
            accessibilityLabel={t('ventes.advancedSearch.fieldNumber', { personality })}
            style={fieldStyle}
          />

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 14 }]}>
            {t('ventes.advancedSearch.fieldLabel', { personality }).toUpperCase()}
          </Text>
          <TextInput
            value={label}
            onChangeText={setLabel}
            placeholder={t('ventes.advancedSearch.labelPlaceholder', { personality })}
            placeholderTextColor={colors.slate300}
            accessibilityLabel={t('ventes.advancedSearch.fieldLabel', { personality })}
            style={fieldStyle}
          />

          <Text style={[font('label', 700), { color: colors.slate400, marginTop: 14, marginBottom: 7 }]}>
            {t('ventes.advancedSearch.fieldDates', { personality }).toUpperCase()}
          </Text>
          <DateRangeChips value={dateRange} onChange={setDateRange} today={today} />

          {statusOptions.length > 0 ? (
            <>
              <Text style={[font('label', 700), { color: colors.slate400, marginTop: 14, marginBottom: 7 }]}>
                {t('ventes.advancedSearch.fieldStatus', { personality }).toUpperCase()}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Chip label={t('ventes.advancedSearch.statusAny', { personality })} active={status === null} onPress={() => setStatus(null)} />
                {statusOptions.map((option) => (
                  <Chip
                    key={option.value}
                    label={option.label}
                    active={status === option.value}
                    onPress={() => setStatus(status === option.value ? null : option.value)}
                  />
                ))}
              </View>
            </>
          ) : null}

          <View style={{ flexDirection: 'row', gap: 10, marginTop: 20, marginBottom: 4 }}>
            <Button
              title={t('ventes.advancedSearch.reset', { personality })}
              variant="secondary"
              onPress={reset}
              style={{ flex: 1 }}
            />
            <Button
              title={t('ventes.advancedSearch.submit', { personality })}
              onPress={submit}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
