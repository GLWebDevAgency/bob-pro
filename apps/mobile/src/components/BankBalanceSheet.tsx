import { useEffect, useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Text, TextInput, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { t, type Personality } from '@bob/i18n';
import { Button, Sheet, font, useTheme } from '@bob/ui';
import { useRecordManualBankBalance } from '../data/hooks';
import { formatCentsForEuroInput, parseEuroAmountToCents } from '../finance/parse-euro-amount';

interface BankBalanceSheetProps {
  readonly visible: boolean;
  readonly personality: Personality;
  readonly currentAmountCents: number | null;
  readonly onClose: () => void;
}

export function BankBalanceSheet({
  visible,
  personality,
  currentAmountCents,
  onClose,
}: BankBalanceSheetProps) {
  const { colors, controls, semantic } = useTheme();
  const save = useRecordManualBankBalance();
  const [value, setValue] = useState('');
  const cents = useMemo(() => parseEuroAmountToCents(value), [value]);

  useEffect(() => {
    if (!visible) return;
    setValue(formatCentsForEuroInput(currentAmountCents));
    save.reset();
  }, [currentAmountCents, visible]);

  const close = (): void => {
    if (!save.isPending) onClose();
  };

  const submit = (): void => {
    if (cents === null || save.isPending) return;
    save.mutate(
      { amountCents: cents, observedAt: new Date().toISOString() },
      { onSuccess: onClose },
    );
  };

  return (
    <Sheet
      visible={visible}
      onClose={close}
      accessibilityLabel={t('argent.balanceSheetTitle', { personality })}
      closeAccessibilityLabel={t('common.close', { personality })}
    >
      <KeyboardAvoidingView {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}>
        <Text accessibilityRole="header" style={[font('section'), { color: colors.ink800 }]}>
          {t('argent.balanceSheetTitle', { personality })}
        </Text>
        <Text style={[font('body'), { color: colors.slate500, lineHeight: 21, marginTop: 7 }]}>
          {t('argent.balanceSheetBody', { personality })}
        </Text>

        <View style={{ marginTop: 18 }}>
          <Text style={[font('label', 600), { color: colors.ink800, marginBottom: 7 }]}>
            {t('argent.balanceFieldLabel', { personality })}
          </Text>
          <View
            style={{
              minHeight: 54,
              borderWidth: 1,
              borderColor:
                cents === null && value.length > 0 ? semantic.dangerVivid : controls.cardBorder,
              borderRadius: 15,
              backgroundColor: colors.surface,
              paddingHorizontal: 14,
              flexDirection: 'row',
              alignItems: 'center',
            }}
          >
            <TextInput
              value={value}
              onChangeText={setValue}
              editable={!save.isPending}
              autoFocus
              selectTextOnFocus
              keyboardType="decimal-pad"
              returnKeyType="done"
              onSubmitEditing={submit}
              accessibilityLabel={t('argent.balanceFieldLabel', { personality })}
              placeholder="0,00"
              placeholderTextColor={colors.slate300}
              style={{
                ...font('body', 700),
                color: colors.ink800,
                flex: 1,
                fontVariant: ['tabular-nums'],
              }}
            />
            <Text style={[font('body', 700), { color: colors.slate500 }]}>€</Text>
          </View>
          {cents === null && value.length > 0 ? (
            <Text
              accessibilityRole="alert"
              style={[font('meta'), { color: semantic.dangerVivid, marginTop: 6 }]}
            >
              {t('argent.balanceInvalid', { personality })}
            </Text>
          ) : null}
        </View>

        <View
          style={{
            marginTop: 14,
            padding: 12,
            borderRadius: 14,
            backgroundColor: semantic.b2bBg,
            flexDirection: 'row',
            gap: 9,
          }}
        >
          <Feather name="shield" size={16} color={semantic.b2b} />
          <Text style={[font('meta'), { color: colors.slate500, lineHeight: 18, flex: 1 }]}>
            {t('argent.balanceProof', { personality })}
          </Text>
        </View>

        {save.isError ? (
          <Text
            accessibilityRole="alert"
            style={[font('meta'), { color: semantic.dangerVivid, marginTop: 12 }]}
          >
            {t('argent.balanceSaveError', { personality })}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 20 }}>
          <View style={{ flex: 1 }}>
            <Button
              title={t('common.cancel', { personality })}
              variant="secondary"
              onPress={close}
              disabled={save.isPending}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title={
                save.isPending
                  ? t('argent.balanceSaving', { personality })
                  : t('argent.balanceConfirm', { personality })
              }
              variant="primary"
              onPress={submit}
              disabled={cents === null || save.isPending}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
