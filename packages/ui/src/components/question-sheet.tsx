/**
 * QuestionSheet (ASK-1) — la question structurée de Bob, à la « Claude Code » : quand la
 * demande est ambiguë ou qu'il manque une précision, l'agent pose UNE question à choix
 * unique (radio) ou multiple (checkbox), chaque option portant un libellé court + une
 * description (client, montant, conséquence). Composé sur Sheet (bottom sheet maison).
 * Composant PUR UI : textes fournis par l'appelant (i18n côté app), zéro hex (useTheme).
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme, font } from '../theme';
import { Sheet } from './sheet';
import { Button } from './button';

export interface QuestionSheetOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionSheetProps {
  readonly visible: boolean;
  /** Étiquette courte (chip au-dessus de la question) — ex. « Facture ». */
  readonly header: string;
  readonly question: string;
  readonly options: readonly QuestionSheetOption[];
  /** Choix multiple (checkboxes + bouton valider) — défaut : choix unique (tap direct). */
  readonly multiSelect?: boolean;
  /** Libellé du bouton de validation (multi) — i18n côté app. */
  readonly confirmLabel: string;
  /** Libellé du geste d'échappement « autre / préciser » — i18n côté app. */
  readonly otherLabel: string;
  readonly onClose: () => void;
  /** Sélection validée : les valeurs choisies (une seule en choix unique). */
  readonly onSelect: (values: string[]) => void;
  /** L'utilisateur préfère répondre librement : l'app focus l'input du chat. */
  readonly onOther: () => void;
}

export function QuestionSheet({
  visible,
  header,
  question,
  options,
  multiSelect = false,
  confirmLabel,
  otherLabel,
  onClose,
  onSelect,
  onOther,
}: QuestionSheetProps) {
  const { colors, semantic, controls, radius } = useTheme();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  // Nouvelle question (ou réouverture) : sélection remise à zéro.
  useEffect(() => {
    if (visible) setPicked(new Set());
  }, [visible, question]);

  const toggle = (value: string): void => {
    if (!multiSelect) {
      onSelect([value]);
      return;
    }
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  return (
    <Sheet visible={visible} onClose={onClose}>
      <View
        style={{
          alignSelf: 'flex-start',
          backgroundColor: controls.segmentedTrack,
          borderRadius: radius.pill,
          paddingHorizontal: 10,
          paddingVertical: 4,
          marginBottom: 8,
        }}
      >
        <Text style={[font('meta', 700), { color: colors.slate500, letterSpacing: 0.4, textTransform: 'uppercase' }]}>
          {header}
        </Text>
      </View>
      <Text style={[font('cardTitle'), { color: colors.ink900, marginBottom: 12, lineHeight: 22 }]}>{question}</Text>

      <ScrollView style={{ maxHeight: 340 }} showsVerticalScrollIndicator={false}>
        {options.map((option) => {
          const selected = picked.has(option.value);
          return (
            <Pressable
              key={option.value}
              accessibilityRole={multiSelect ? 'checkbox' : 'radio'}
              accessibilityState={{ selected }}
              accessibilityLabel={option.description ? `${option.label} — ${option.description}` : option.label}
              onPress={() => toggle(option.value)}
              style={({ pressed }) => [
                {
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  gap: 11,
                  borderWidth: 1.5,
                  borderColor: selected ? semantic.success : colors.lineSoft,
                  backgroundColor: selected ? controls.segmentedTrack : colors.surface,
                  borderRadius: 14,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  marginBottom: 8,
                  minHeight: 44,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              {/* Puce radio / case à cocher — dessinée (pas d'icône : cohérence tokens) */}
              <View
                style={{
                  width: 18,
                  height: 18,
                  marginTop: 1,
                  borderRadius: multiSelect ? 5 : 9,
                  borderWidth: 2,
                  borderColor: selected ? semantic.success : controls.sheetHandle,
                  backgroundColor: selected ? semantic.success : colors.surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selected ? (
                  <Text style={{ color: colors.surface, fontSize: 11, fontWeight: '800', lineHeight: 13 }}>✓</Text>
                ) : null}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[font('sub', 700), { color: colors.ink900 }]}>{option.label}</Text>
                {option.description ? (
                  <Text style={[font('meta'), { color: colors.slate500, marginTop: 2, lineHeight: 17 }]}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </ScrollView>

      {multiSelect ? (
        <View style={{ marginTop: 4 }}>
          <Button
            title={confirmLabel}
            variant="ai"
            radius={14}
            disabled={picked.size === 0}
            onPress={() => onSelect([...picked])}
          />
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={otherLabel}
        onPress={onOther}
        style={{ alignSelf: 'center', minHeight: 40, justifyContent: 'center', marginTop: multiSelect ? 6 : 2 }}
      >
        <Text style={[font('sub', 600), { color: colors.slate500 }]}>{otherLabel}</Text>
      </Pressable>
    </Sheet>
  );
}
