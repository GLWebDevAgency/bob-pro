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
import { Text } from 'react-native';
import { formatEURWhole, type ValueDigest } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import { Card, font, useTheme } from '@bob/ui';

/**
 * Dernier digest de valeur du tenant — null tant qu'aucun digest réel n'existe (jamais de bruit).
 *
 * TODO(serveur — SPEC pilier 2, « Reste à implémenter » §3) : le digest est déjà CALCULÉ côté
 * API (apps/api/src/jobs/digest.service.ts — buildValueDigest sur les données réelles, outbox
 * kind 'weekly-digest', dedupeKey `digest:{companyId}:{isoWeek}:{POLICY_VERSION}`), mais seul
 * le TEXTE part en notification : le ValueDigest STRUCTURÉ n'est pas encore exposé au mobile.
 * Brancher ici, au choix (décision serveur à venir) :
 * · un endpoint GET /engagement/digest/latest (ValueDigest + isoWeek) consommé en useQuery
 *   (clé ['value-digest'], pattern src/data/hooks.ts) ;
 * · ou le payload structuré joint au job 'weekly-digest' quand GET /notifications le portera
 *   (la notification route déjà vers Aujourd'hui — notification-route.ts).
 * Tant que rien ne répond : null → la carte est invisible, zéro régression visuelle.
 */
export function useLatestValueDigest(): ValueDigest | null {
  return null;
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
      return { key: 'digest.volume', params: { count: h.documents }, estimated: false };
  }
}

/** Carte digest — présentation pure : le digest arrive en prop (non-null par contrat de type). */
export function ValueDigestCard({ digest }: { readonly digest: ValueDigest }): React.JSX.Element {
  const { personality, colors } = useTheme();
  const highlight = highlightCopy(digest);
  const title = t('digest.title', { personality });
  const line = t(highlight.key, { personality, params: highlight.params });

  return (
    <Card>
      <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{title}</Text>
      <Text style={[font('sub', 700), { fontSize: 15.5, lineHeight: 22, color: colors.ink900, marginTop: 6 }]}>
        {line}
      </Text>
      {highlight.estimated ? (
        <Text style={[font('meta'), { color: colors.slate400, marginTop: 8 }]}>
          {t('digest.estimateNote', { personality })}
        </Text>
      ) : null}
    </Card>
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
