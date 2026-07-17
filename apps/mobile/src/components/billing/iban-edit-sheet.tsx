/**
 * IbanEditSheet — édition du RIB (Réglages facturation §Coordonnées bancaires). Seul champ
 * d'identité RÉELLEMENT éditable depuis cet écran (PATCH /company/billing, ajouté avec ce
 * chantier — iban/bic existaient déjà sur CompanyProps mais n'avaient jamais d'endpoint
 * d'écriture après l'onboarding). Validation cliente (Iban.of, même règle que le serveur —
 * mod 97) avant l'appel réseau ; le serveur revalide de toute façon.
 */
import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Iban } from '@bob/core';
import { t, type I18nKey, type Personality } from '@bob/i18n';
import { Button, Sheet, font, useTheme } from '@bob/ui';
import { useUpdateCompanyBilling } from '../../data/hooks';

export interface IbanEditSheetProps {
  readonly visible: boolean;
  readonly currentIban: string | null;
  readonly personality: Personality;
  readonly onClose: () => void;
}

export function IbanEditSheet({ visible, currentIban, personality, onClose }: IbanEditSheetProps) {
  const { colors, semantic } = useTheme();
  const updateBilling = useUpdateCompanyBilling();
  const [value, setValue] = useState(currentIban ?? '');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (visible) {
      setValue(currentIban ?? '');
      setTouched(false);
      updateBilling.reset();
    }
  }, [visible, currentIban]);

  const say = (key: I18nKey) => t(key, { personality });
  const trimmed = value.trim();
  const parsed = trimmed.length > 0 ? Iban.of(trimmed) : null;
  const invalid = touched && trimmed.length > 0 && parsed !== null && !parsed.ok;
  const busy = updateBilling.isPending;
  const canSave = trimmed.length === 0 || (parsed !== null && parsed.ok);

  const handleClose = (): void => {
    if (!busy) onClose();
  };

  const handleSave = async (): Promise<void> => {
    if (!canSave || busy) return;
    try {
      await updateBilling.mutateAsync({
        iban: trimmed.length === 0 ? null : (parsed as { ok: true; value: Iban }).value.value,
      });
      onClose();
    } catch {
      // erreur affichée via updateBilling.isError ci-dessous
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={handleClose}
      accessibilityLabel={say('reglages.ibanSheetTitle')}
      closeAccessibilityLabel={say('reglages.ibanSheetCancel')}
    >
      <Text accessibilityRole="header" style={[font('cardTitle'), { color: colors.ink900, marginBottom: 8 }]}>
        {say('reglages.ibanSheetTitle')}
      </Text>
      <Text style={[font('body'), { color: colors.slate500, lineHeight: 20, marginBottom: 16 }]}>
        {say('reglages.ibanSheetBody')}
      </Text>

      <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.ink800, marginBottom: 6 }]}>
        {say('reglages.ibanSheetLabel')}
      </Text>
      <TextInput
        value={value}
        onChangeText={(next) => {
          setValue(next);
          setTouched(true);
        }}
        onBlur={() => setTouched(true)}
        editable={!busy}
        autoCapitalize="characters"
        autoCorrect={false}
        placeholder={say('reglages.ibanSheetPlaceholder')}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={say('reglages.ibanSheetLabel')}
        style={[
          font('body'),
          {
            minHeight: 44,
            color: colors.ink900,
            borderWidth: 1,
            borderColor: invalid ? semantic.danger : colors.line,
            borderRadius: 12,
            paddingHorizontal: 12,
            marginBottom: 8,
          },
        ]}
      />
      {invalid ? (
        <Text style={[font('meta', 600), { color: semantic.danger, marginBottom: 12 }]}>
          {say('reglages.ibanSheetInvalid')}
        </Text>
      ) : (
        <View style={{ marginBottom: 12 }} />
      )}

      {updateBilling.isError ? (
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={{ marginBottom: 12, borderRadius: 12, padding: 10, backgroundColor: semantic.dangerBg }}
        >
          <Text style={[font('meta', 600), { color: semantic.danger }]}>{say('reglages.ibanSheetError')}</Text>
        </View>
      ) : null}

      <Button
        title={say('reglages.ibanSheetSave')}
        variant="primary"
        loading={busy}
        disabled={!canSave || busy}
        onPress={() => void handleSave()}
      />
      <View style={{ marginTop: 8 }}>
        <Button title={say('reglages.ibanSheetCancel')} variant="secondary" disabled={busy} onPress={handleClose} />
      </View>
    </Sheet>
  );
}
