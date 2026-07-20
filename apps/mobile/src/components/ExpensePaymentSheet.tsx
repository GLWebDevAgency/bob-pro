import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import {
  EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH,
  parisDateOnly,
  type ExpensePaymentEvidenceInput,
  type PaymentMethod,
} from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { Button, Chip, Sheet, font, useTheme } from '@bob/ui';
import {
  displayExpensePaymentDate,
  validateExpensePaymentDate,
} from '../finance/expense-payment-form';

/**
 * `record` : règlement d'une dépense à payer (E4). `regularize` : MÊME formulaire pour justifier
 * une ligne HISTORIQUE payée sans preuve — seuls le titre et le texte porteur de sens changent,
 * l'appelant route vers l'endpoint de régularisation.
 */
export type ExpensePaymentSheetMode = 'record' | 'regularize';

export interface ExpensePaymentSheetProps {
  readonly visible: boolean;
  readonly personality: Personality;
  readonly supplierName: string | null;
  readonly mode?: ExpensePaymentSheetMode;
  readonly initialEvidence?: ExpensePaymentEvidenceInput | null;
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (evidence: ExpensePaymentEvidenceInput) => void;
}

const METHODS: readonly { readonly value: PaymentMethod; readonly key: I18nKey }[] = [
  { value: 'card', key: 'dep.paymentMethodCard' },
  { value: 'transfer', key: 'dep.paymentMethodTransfer' },
  { value: 'cash', key: 'dep.paymentMethodCash' },
];

export function ExpensePaymentSheet({
  visible,
  personality,
  supplierName,
  mode = 'record',
  initialEvidence = null,
  error = null,
  onClose,
  onSubmit,
}: ExpensePaymentSheetProps) {
  const { colors, semantic } = useTheme();
  const today = parisDateOnly();
  const [date, setDate] = useState('');
  const [method, setMethod] = useState<PaymentMethod | null>(null);
  const [reference, setReference] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setDate(initialEvidence ? displayExpensePaymentDate(initialEvidence.paidOn) : '');
    setMethod(initialEvidence?.method ?? null);
    setReference(initialEvidence?.reference ?? '');
    setTouched(false);
  }, [visible, supplierName, initialEvidence]);

  const say = (key: I18nKey) => t(key, { personality });
  const titleKey: I18nKey = mode === 'regularize' ? 'dep.regularizeSheetTitle' : 'dep.paymentSheetTitle';
  const bodyKey: I18nKey = mode === 'regularize' ? 'dep.regularizeSheetBody' : 'dep.paymentSheetBody';
  const dateResult = validateExpensePaymentDate(date, today);
  const valid = dateResult.ok && method !== null;
  const dateErrorKey: I18nKey = dateResult.ok
    ? 'dep.paymentDateInvalid'
    : dateResult.error === 'required'
      ? 'dep.paymentDateRequired'
      : dateResult.error === 'future'
        ? 'dep.paymentDateFuture'
        : 'dep.paymentDateInvalid';

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      accessibilityLabel={say(titleKey)}
      closeAccessibilityLabel={say('dep.paymentCancel')}
    >
      <Text
        accessibilityRole="header"
        style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}
      >
        {say(titleKey)}
      </Text>
      <Text style={[font('body'), { color: colors.slate500, lineHeight: 20, marginBottom: 16 }]}>
        {t(bodyKey, {
          personality,
          params: { supplier: supplierName ?? '' },
        })}
      </Text>

      <Text style={[font('sub', 600), { color: colors.ink800, marginBottom: 6 }]}> 
        {say('dep.paymentDateLabel')}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <TextInput
          value={date}
          onChangeText={setDate}
          onBlur={() => setTouched(true)}
          keyboardType="numbers-and-punctuation"
          maxLength={10}
          placeholder={say('dep.paymentDatePlaceholder')}
          placeholderTextColor={colors.slate400}
          accessibilityLabel={say('dep.paymentDateLabel')}
          style={[
            font('body'),
            {
              flex: 1,
              minHeight: 44,
              color: colors.ink900,
              borderWidth: 1,
              borderColor: touched && !dateResult.ok ? semantic.danger : colors.line,
              borderRadius: 12,
              paddingHorizontal: 12,
            },
          ]}
        />
        <Button
          title={say('dep.paymentToday')}
          variant="secondary"
          size="compact"
          onPress={() => {
            setDate(displayExpensePaymentDate(today));
            setTouched(true);
          }}
        />
      </View>
      {touched && !dateResult.ok ? (
        <Text
          accessibilityRole="alert"
          style={[font('meta', 600), { color: semantic.danger, marginTop: 5 }]}
        >
          {say(dateErrorKey)}
        </Text>
      ) : null}

      <Text style={[font('sub', 600), { color: colors.ink800, marginTop: 16, marginBottom: 7 }]}> 
        {say('dep.paymentMethodLabel')}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {METHODS.map((option) => (
          <Chip
            key={option.value}
            label={say(option.key)}
            active={method === option.value}
            onPress={() => setMethod(option.value)}
          />
        ))}
      </View>
      {touched && method === null ? (
        <Text
          accessibilityRole="alert"
          style={[font('meta', 600), { color: semantic.danger, marginTop: 5 }]}
        >
          {say('dep.paymentMethodRequired')}
        </Text>
      ) : null}

      <Text style={[font('sub', 600), { color: colors.ink800, marginTop: 16, marginBottom: 6 }]}> 
        {say('dep.paymentReferenceLabel')}
      </Text>
      <TextInput
        value={reference}
        onChangeText={setReference}
        maxLength={EXPENSE_PAYMENT_REFERENCE_MAX_LENGTH}
        placeholder={say('dep.paymentReferencePlaceholder')}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={say('dep.paymentReferenceLabel')}
        autoCapitalize="characters"
        style={[
          font('body'),
          {
            minHeight: 44,
            color: colors.ink900,
            borderWidth: 1,
            borderColor: colors.line,
            borderRadius: 12,
            paddingHorizontal: 12,
          },
        ]}
      />

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

      <View style={{ marginTop: 18 }}>
        <Button
          title={say('dep.paymentContinue')}
          onPress={() => {
            setTouched(true);
            if (!valid || !dateResult.ok || method === null) return;
            onSubmit({
              paidOn: dateResult.value,
              method,
              reference: reference.trim() || null,
              proofDocumentId: null,
            });
          }}
        />
      </View>
      <View style={{ marginTop: 8 }}>
        <Button title={say('dep.paymentCancel')} variant="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}
