/**
 * B9 — dropdown d'autocomplétion sous le champ de recherche Ventes (GET /documents/suggest,
 * debounce ~250 ms côté appelant). Rendu INLINE sous le champ (pas d'overlay absolu — même
 * recette que les suggestions d'adresse de chantiers.tsx) : sections typées avec icône
 * (client/numéro/prestation), tap = applique. Input vide -> « recherches récentes » (état
 * local à l'écran, cf. commentaire useRecentSalesSearches).
 */
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { t, type I18nKey } from '@bob/i18n';
import { Skeleton, useTheme } from '@bob/ui';
import type { SalesDocumentSuggestion, SalesDocumentSuggestionKind } from '@bob/core';
import { font } from './ui';

const MAX_RECENT = 5;

/** Historique de recherche « récentes d'abord si input vide » — volontairement SESSION ONLY
 * (pas d'AsyncStorage) : c'est un confort de frappe, pas une donnée à faire persister/RGPD. */
export function useRecentSalesSearches() {
  const [recent, setRecent] = useState<string[]>([]);
  const push = (query: string): void => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    setRecent((current) => [trimmed, ...current.filter((q) => q.toLowerCase() !== trimmed.toLowerCase())].slice(0, MAX_RECENT));
  };
  return { recent, push };
}

const KIND_ICON: Record<SalesDocumentSuggestionKind, keyof typeof Ionicons.glyphMap> = {
  customer: 'person-outline',
  number: 'document-text-outline',
  label: 'construct-outline',
};

function sectionLabelKey(kind: SalesDocumentSuggestionKind): I18nKey {
  return kind === 'customer' ? 'ventes.suggest.sectionCustomers' : kind === 'number' ? 'ventes.suggest.sectionNumbers' : 'ventes.suggest.sectionLabels';
}

export function DocumentSearchAutocomplete({
  query,
  suggestions,
  loading,
  recentQueries,
  onSelectSuggestion,
  onSelectRecent,
}: {
  readonly query: string;
  readonly suggestions: readonly SalesDocumentSuggestion[] | undefined;
  readonly loading: boolean;
  readonly recentQueries: readonly string[];
  readonly onSelectSuggestion: (suggestion: SalesDocumentSuggestion) => void;
  readonly onSelectRecent: (query: string) => void;
}) {
  const { colors, personality } = useTheme();
  const showRecent = query.trim().length === 0;

  if (showRecent) {
    if (recentQueries.length === 0) return null;
    return (
      <View accessibilityLiveRegion="polite" style={{ marginTop: 6, gap: 2 }}>
        <Text style={[font('meta'), { color: colors.slate400, marginBottom: 2 }]}>
          {t('ventes.suggest.sectionRecent', { personality })}
        </Text>
        {recentQueries.map((recentQuery) => (
          <Pressable
            key={recentQuery}
            accessibilityRole="button"
            accessibilityLabel={recentQuery}
            onPress={() => onSelectRecent(recentQuery)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 4 }}
          >
            <Ionicons name="time-outline" size={16} color={colors.slate400} />
            <Text style={[font('sub'), { color: colors.ink800 }]}>{recentQuery}</Text>
          </Pressable>
        ))}
      </View>
    );
  }

  if (loading) {
    return (
      <View style={{ marginTop: 9, gap: 6 }}>
        <Skeleton height={13} width="70%" radius={6} />
        <Skeleton height={13} width="55%" radius={6} />
      </View>
    );
  }

  if (suggestions === undefined || suggestions.length === 0) return null;

  const sections: SalesDocumentSuggestionKind[] = ['customer', 'number', 'label'];
  return (
    <View accessibilityLiveRegion="polite" style={{ marginTop: 6 }}>
      {sections.map((kind) => {
        const items = suggestions.filter((s) => s.kind === kind);
        if (items.length === 0) return null;
        return (
          <View key={kind} style={{ marginBottom: 6 }}>
            <Text style={[font('meta'), { color: colors.slate400, marginBottom: 2 }]}>
              {t(sectionLabelKey(kind), { personality })}
            </Text>
            {items.map((suggestion) => (
              <Pressable
                key={`${suggestion.kind}-${suggestion.value}`}
                accessibilityRole="button"
                accessibilityLabel={suggestion.value}
                onPress={() => onSelectSuggestion(suggestion)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40, paddingHorizontal: 4 }}
              >
                <Ionicons name={KIND_ICON[suggestion.kind]} size={16} color={colors.slate400} />
                <Text style={[font('sub'), { color: colors.ink800, flex: 1 }]} numberOfLines={1}>
                  {suggestion.value}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400 }]}>
                  {t('ventes.suggest.count', { personality, params: { count: suggestion.count } })}
                </Text>
              </Pressable>
            ))}
          </View>
        );
      })}
    </View>
  );
}
