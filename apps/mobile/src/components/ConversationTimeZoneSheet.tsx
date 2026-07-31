import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';
import { t } from '@bob/i18n';
import { Button, font, Sheet, useTheme } from '@bob/ui';
import type { ConversationTimeZoneConfirmationState } from '../agent/conversation-time-zone-gate';
import {
  canonicalConversationTimeZoneSelection,
  conversationTimeZoneOptions,
} from '../data/conversation-time-zone-options';

export interface ConversationTimeZoneSheetProps {
  readonly state: ConversationTimeZoneConfirmationState | null;
  readonly onConfirm: (timeZone: string) => void;
  readonly onRedetect: () => void;
  readonly onCancel: () => void;
}

/**
 * Décision préalable à Bob Live : la détection appareil reste une suggestion. La recherche et la
 * saisie IANA gardent le parcours utilisable même si la plateforme ne détecte rien.
 */
export function ConversationTimeZoneSheet({
  state,
  onConfirm,
  onRedetect,
  onCancel,
}: ConversationTimeZoneSheetProps) {
  const { colors, controls, semantic, personality, radius } = useTheme();
  const [query, setQuery] = useState('');
  const [selectedTimeZone, setSelectedTimeZone] = useState<string | null>(null);
  const saving = state?.phase === 'saving';
  const title = t('agent.global.timeZoneTitle', { personality });
  const cancelLabel = t('agent.global.timeZoneCancel', { personality });

  useEffect(() => {
    if (state === null) {
      setQuery('');
      setSelectedTimeZone(null);
      return;
    }
    const suggestion = state.suggestedTimeZone;
    setQuery(suggestion ?? '');
    setSelectedTimeZone(suggestion);
  }, [state?.detectionRevision, state === null]);

  const options = useMemo(
    () => conversationTimeZoneOptions({
      query,
      suggestedTimeZone: state?.suggestedTimeZone ?? null,
    }),
    [query, state?.suggestedTimeZone],
  );
  const exactSelection = canonicalConversationTimeZoneSelection(query);
  const confirmationLabel = selectedTimeZone === null
    ? t('agent.global.timeZoneConfirmSelection', { personality })
    : t('agent.global.timeZoneConfirm', {
        personality,
        params: { timeZone: selectedTimeZone },
      });

  return (
    <Sheet
      visible={state !== null}
      onClose={saving ? () => undefined : onCancel}
      accessibilityLabel={title}
      closeAccessibilityLabel={cancelLabel}
      closeAccessibilityHint={cancelLabel}
      closeBusy={saving}
    >
      <View
        accessible={false}
        importantForAccessibility="no"
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: semantic.aiBg,
          marginBottom: 12,
        }}
      >
        <Text
          accessible={false}
          allowFontScaling={false}
          style={[font('cardTitle'), { color: semantic.aiInk }]}
        >
          ◷
        </Text>
      </View>

      <Text
        accessibilityRole="header"
        style={[font('pageTitle'), { color: colors.ink900, marginBottom: 8 }]}
      >
        {title}
      </Text>
      <Text
        style={[
          font('body'),
          { color: colors.ink600, lineHeight: 22, marginBottom: 16 },
        ]}
      >
        {t('agent.global.timeZoneBody', { personality })}
      </Text>

      <TextInput
        value={query}
        editable={!saving}
        onChangeText={(value) => {
          if (saving) return;
          setQuery(value);
          setSelectedTimeZone(canonicalConversationTimeZoneSelection(value));
        }}
        placeholder={t('agent.global.timeZoneSearchPlaceholder', { personality })}
        placeholderTextColor={colors.slate500}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        accessibilityLabel={t('agent.global.timeZoneSearchLabel', { personality })}
        accessibilityState={{ disabled: saving }}
        style={[
          font('body'),
          {
            minHeight: 48,
            borderRadius: 14,
            paddingHorizontal: 14,
            color: colors.ink900,
            backgroundColor: controls.segmentedTrack,
            borderWidth: 1,
            borderColor: exactSelection === null && query.trim().length > 0
              ? controls.cardBorder
              : semantic.ai,
            marginBottom: 8,
          },
        ]}
      />

      <View
        accessibilityRole="radiogroup"
        style={{ gap: 6, marginBottom: 12 }}
      >
        {options.slice(0, 8).map((option) => {
          const selected = option.timeZone === selectedTimeZone;
          return (
            <Pressable
              key={option.timeZone}
              disabled={saving}
              accessibilityRole="radio"
              accessibilityLabel={option.timeZone}
              accessibilityHint={
                option.suggested
                  ? t('agent.global.timeZoneSuggested', { personality })
                  : undefined
              }
              accessibilityState={{ selected, disabled: saving }}
              onPress={() => {
                if (saving) return;
                setSelectedTimeZone(option.timeZone);
                setQuery(option.timeZone);
              }}
              style={({ pressed }) => ({
                minHeight: 44,
                borderRadius: 12,
                paddingHorizontal: 12,
                paddingVertical: 10,
                justifyContent: 'center',
                backgroundColor: selected || pressed
                  ? semantic.aiBg
                  : controls.segmentedTrack,
                borderWidth: 1,
                borderColor: selected ? semantic.ai : controls.cardBorder,
                opacity: saving ? 0.6 : 1,
              })}
            >
              <Text style={[font('sub', selected ? 700 : 600), { color: colors.ink900 }]}>
                {option.timeZone}
                {option.suggested
                  ? ` · ${t('agent.global.timeZoneSuggested', { personality })}`
                  : ''}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {query.trim().length > 0 && options.length === 0 ? (
        <Text
          accessibilityRole="alert"
          style={[font('sub'), { color: colors.ink600, marginBottom: 12 }]}
        >
          {t('agent.global.timeZoneInvalid', { personality })}
        </Text>
      ) : null}

      {state?.issue !== null && state?.issue !== undefined ? (
        <Text
          accessibilityRole={state.issue === 'confirmation_failed' ? 'alert' : undefined}
          accessibilityLiveRegion={
            state.issue === 'confirmation_failed' ? 'assertive' : 'polite'
          }
          style={[
            font('sub', 600),
            {
              color: state.issue === 'confirmation_failed'
                ? semantic.danger
                : colors.ink600,
              lineHeight: 20,
              marginBottom: 12,
            },
          ]}
        >
          {t(
            state.issue === 'confirmation_failed'
              ? 'agent.global.timeZoneError'
              : 'agent.global.timeZoneDetectionUnavailable',
            { personality },
          )}
        </Text>
      ) : null}

      <Button
        title={saving
          ? t('agent.global.timeZoneSaving', { personality })
          : confirmationLabel}
        variant="ai"
        radius={14}
        disabled={selectedTimeZone === null || saving}
        loading={saving}
        onPress={() => {
          if (selectedTimeZone !== null && !saving) onConfirm(selectedTimeZone);
        }}
      />

      <Button
        title={t('agent.global.timeZoneRedetect', { personality })}
        variant="secondary"
        radius={14}
        disabled={saving}
        onPress={onRedetect}
        style={{ marginTop: 8 }}
      />

      <Button
        title={cancelLabel}
        variant="secondary"
        radius={14}
        disabled={saving}
        onPress={onCancel}
        style={{ marginTop: 8 }}
      />
    </Sheet>
  );
}
