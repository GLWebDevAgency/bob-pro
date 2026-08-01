/**
 * FormField / DateField — champ de formulaire du kit (Lot 0, plan DA 01/08) : label
 * VISIBLE PERSISTANT + input tokenisé (minHeight 44, bord cardBorder → danger en erreur)
 * + slot d'erreur danger (role alert, annoncé). DateField = préréglage date avec masque
 * AAAA-MM-JJ purement visuel (form-field.logic). Consommateurs (lots 3 et 4) :
 * equipements, equipement/[id], contrat/new, feuille période facture/[id] — AUCUN migré ici.
 */
import type { StyleProp, ViewStyle } from 'react-native';
import { Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { font, useTheme } from '../theme';
import {
  FORM_FIELD_MIN_HEIGHT,
  FORM_FIELD_PADDING_HORIZONTAL,
  FORM_FIELD_RADIUS,
  applyDateMask,
  formFieldBorderColor,
} from './form-field.logic';

export interface FormFieldProps {
  /** Label VISIBLE persistant — jamais un placeholder seul. */
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  readonly placeholder?: string;
  /** Erreur du champ — rendue en danger avec role alert ; teinte aussi le bord. */
  readonly error?: string | null;
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  readonly keyboardType?: KeyboardTypeOptions;
  readonly editable?: boolean;
  /** Libellé accessible de l'input (défaut : le label visible). */
  readonly accessibilityLabel?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
}

export function FormField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  autoCapitalize = 'sentences',
  keyboardType,
  editable = true,
  accessibilityLabel,
  style,
  testID,
}: FormFieldProps) {
  const { colors, controls, semantic } = useTheme();
  const hasError = error !== undefined && error !== null && error !== '';
  return (
    <View {...(testID !== undefined ? { testID } : {})} style={style}>
      <Text style={[font('label'), { color: colors.slate500, marginBottom: 6 }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        {...(placeholder !== undefined ? { placeholder } : {})}
        placeholderTextColor={colors.slate400}
        autoCapitalize={autoCapitalize}
        {...(keyboardType !== undefined ? { keyboardType } : {})}
        editable={editable}
        accessibilityLabel={accessibilityLabel ?? label}
        style={[
          font('body'),
          {
            minHeight: FORM_FIELD_MIN_HEIGHT,
            borderWidth: 1,
            borderColor: formFieldBorderColor(hasError, {
              cardBorder: controls.cardBorder,
              danger: semantic.danger,
            }),
            borderRadius: FORM_FIELD_RADIUS,
            paddingHorizontal: FORM_FIELD_PADDING_HORIZONTAL,
            color: colors.ink800,
            backgroundColor: colors.surface,
          },
        ]}
      />
      {hasError ? (
        <Text
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          style={[font('sub', 500), { color: semantic.danger, marginTop: 6 }]}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export interface DateFieldProps
  extends Omit<FormFieldProps, 'onChangeText' | 'placeholder' | 'autoCapitalize' | 'keyboardType'> {
  /** Reçoit la valeur DÉJÀ masquée AAAA-MM-JJ (le masque est purement visuel). */
  readonly onChangeText: (masked: string) => void;
}

/** Champ de date — FormField préréglé, masque AAAA-MM-JJ purement visuel à la frappe. */
export function DateField({ onChangeText, ...rest }: DateFieldProps) {
  return (
    <FormField
      {...rest}
      placeholder="AAAA-MM-JJ"
      autoCapitalize="none"
      keyboardType="numbers-and-punctuation"
      onChangeText={(next) => onChangeText(applyDateMask(next))}
    />
  );
}
