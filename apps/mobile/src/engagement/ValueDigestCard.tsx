/**
 * CARTE DIGEST DE VALEUR — « le lundi de Bob » (SPEC_PILIER2_MONETISATION.md, décision 5).
 *
 * Doctrine : réciprocité HONNÊTE. La carte affiche UN ValueDigest calculé par le domaine
 * (`buildValueDigest` @bob/core) sur les faits réels du tenant — jamais un chiffre inventé :
 * · accroche UNIQUE, ordonnée argent > temps > volume — l'artisan lit une phrase, pas un
 *   tableau de bord (l'ordre est décidé par le DOMAINE via digest.highlight, pas par l'UI) ;
 * · le temps économisé est une ESTIMATION : dès qu'il s'affiche, la note digest.estimateNote
 *   l'annonce comme telle ;
 * · un digest sans substance N'EXISTE PAS (null) → la carte ne se rend pas du tout.
 *
 * Montants formatés fr-FR € via formatEURWhole (@bob/core) — la convention des agrégats de
 * l'app (briefing, KPI) : jamais de centimes sur ces surfaces.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatEURWhole, type ValueDigest } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { Card, font, useTheme } from '@bob/ui';
import { useQuery } from '@tanstack/react-query';
import { useBobClient } from '../data/client';
import { CheckIcon, ChevronRightIcon } from '../components/icons';

/**
 * Dernier digest de valeur du tenant — null tant qu'aucun digest réel n'existe (jamais de bruit).
 * Servi par GET /engagement/digest/latest (DigestService.latestForCurrentTenant — les MÊMES
 * projections que le cron « lundi de Bob », jamais deux calculs qui divergent). Sans substance
 * ou sans réseau : null → la carte est invisible, zéro régression visuelle.
 */
export function useLatestValueDigest(): ValueDigest | null {
  const client = useBobClient();
  const query = useQuery({
    queryKey: ['value-digest'],
    queryFn: async () => {
      const result = await client.latestValueDigest();
      if (!result.ok) throw result.error;
      return result.value;
    },
    staleTime: 15 * 60 * 1000, // le digest hebdo ne bouge pas à la minute
    retry: false, // pas de valeur = pas de carte — jamais un spinner de vente
  });
  return query.data?.digest ?? null;
}

/** Accroche unique → clé i18n + interpolations. `estimated` = du TEMPS est affiché (note requise). */
function highlightCopy(digest: ValueDigest): {
  key: I18nKey;
  params: Record<string, string | number>;
  estimated: boolean;
} {
  const h = digest.highlight;
  switch (h.kind) {
    case 'money':
      return {
        key: h.recovered ? 'digest.moneyRecovered' : 'digest.moneyCollected',
        params: { amount: formatEURWhole(h.amountCents) },
        estimated: false,
      };
    case 'time':
      return { key: 'digest.timeSaved', params: { minutes: h.minutes }, estimated: true };
    case 'volume':
      return {
        key: h.documents === 1 ? 'digest.volumeOne' : 'digest.volume',
        params: { count: h.documents },
        estimated: false,
      };
  }
}

/** Le CHIFFRE héros de la semaine — l'argent en Schibsted success, le temps en minutes,
 *  le volume en documents. C'est LE résultat que Bob apporte : il se voit en premier. */
function heroFigure(digest: ValueDigest): string {
  const h = digest.highlight;
  if (h.kind === 'money') return `+ ${formatEURWhole(h.amountCents)}`;
  if (h.kind === 'time') return `≈ ${h.minutes} min`;
  return h.documents === 1 ? '1 document' : `${h.documents} documents`;
}

/**
 * Carte digest — COMPACTE et célébrante (retour device R2) : une rangée, le gain en héros
 * couleur succès, la phrase de fierté en dessous, chevron → Argent (le détail vit là-bas).
 * Le Home respire, le résultat de Bob se voit — jamais un chiffre inventé (digest réel).
 */
export function ValueDigestCard({ digest }: { readonly digest: ValueDigest }): React.JSX.Element {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const client = useBobClient();
  const highlight = highlightCopy(digest);
  const line = t(highlight.key, { personality, params: highlight.params });
  const note = highlight.estimated ? t('digest.estimateNote', { personality }) : null;

  return (
    <Pressable
      onPress={() => {
        // value_digest_opened (pilier 2, analytics décision 11) : l'OUVERTURE réelle du digest —
        // le TAP vers le détail, jamais le rendu de la carte. Fire-and-forget : une analytics
        // perdue (offline, opt-out serveur) ne retarde ni ne casse JAMAIS la navigation.
        void client.recordValueDigestOpened?.(digest.highlight.kind).catch(() => undefined);
        router.push('/(tabs)/argent');
      }}
      accessibilityRole="button"
      accessibilityLabel={`${t('digest.title', { personality })} — ${line}${note ? ` ${note}` : ''}`}
      accessibilityHint={t('digest.openMoneyHint', { personality })}
      style={({ pressed }) => ({
        opacity: pressed ? 0.86 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
      })}
    >
      <Card padding={14}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              backgroundColor: semantic.successBg,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <CheckIcon color={semantic.success} size={20} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <Text style={[font('bigNum'), { fontSize: 22, color: semantic.success }]}>
                {heroFigure(digest)}
              </Text>
              <Text style={[font('eyebrow'), { fontSize: 10, color: colors.slate400 }]}>
                {t('digest.title', { personality })}
              </Text>
            </View>
            <Text style={[font('sub'), { fontSize: 12.5, lineHeight: 17, color: colors.slate500, marginTop: 2 }]} numberOfLines={2}>
              {line}
            </Text>
            {note ? (
              <Text style={[font('meta'), { color: colors.slate500, lineHeight: 15, marginTop: 3 }]}>{note}</Text>
            ) : null}
          </View>
          <ChevronRightIcon color={colors.slate500} size={18} />
        </View>
      </Card>
    </Pressable>
  );
}

/**
 * Intégration écran « Aujourd'hui » : la carte derrière le hook — invisible tant que le
 * serveur n'expose pas le digest (null), sans aucune condition à écrire dans l'écran.
 */
export function LatestValueDigestCard(): React.JSX.Element | null {
  const digest = useLatestValueDigest();
  if (digest === null) return null;
  return <ValueDigestCard digest={digest} />;
}
