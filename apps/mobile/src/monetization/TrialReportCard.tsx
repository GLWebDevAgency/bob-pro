/**
 * BILAN DE FIN D'ESSAI — « Ce que Bob a fait pour toi » (SPEC_PILIER2_MONETISATION.md,
 * décision 2). Vente HONNÊTE : montrer le RÉSULTAT (les chiffres réels du tenant, servis par
 * GET /engagement/trial-report — les mêmes agrégats que le digest hebdo, cumulés sur l'essai),
 * jamais culpabiliser ni compter à rebours de façon anxiogène.
 *
 * Règles :
 * · la carte n'existe QUE près du terme de l'essai (phase ending_soon) ou après (expired) —
 *   en pleine phase active, on laisse l'artisan vivre l'essai, pas le vendre ;
 * · chaque chiffre vient du serveur (faits réels) ; le temps économisé est une ESTIMATION,
 *   annoncée comme telle par la clé i18n dédiée ;
 * · UN CTA (choisir une offre → écran Compte, la grille existante) + la réassurance écrite :
 *   les documents et la facturation conforme restent disponibles quoi qu'il arrive.
 */
import React from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatEURWhole } from '@bob/core';
import type { TrialReportView } from '@bob/api-client';
import { t } from '@bob/i18n';
import { Button, Card, ErrorRetry, font, useTheme } from '@bob/ui';
import { useQuery } from '@tanstack/react-query';
import { useBobClient } from '../data/client';

/**
 * Bilan d'essai du tenant — null tant que le serveur ne rapporte pas un essai proche du terme
 * (pas d'essai, phase active, client sans la capacité, réseau) : la carte ne se rend pas,
 * aucun spinner de vente, zéro régression pour les tenants early-access.
 */
export function useTrialReport() {
  const client = useBobClient();
  const query = useQuery({
    queryKey: ['trial-report'],
    queryFn: async () => {
      if (client.trialReport === undefined) return null;
      const result = await client.trialReport();
      if (!result.ok) throw result.error;
      return result.value;
    },
    staleTime: 60 * 60 * 1000, // S8 : le bilan d'essai bouge au rythme de l'essai — 1 h sans re-GET
    retry: false, // pas de bilan = pas de carte — jamais un spinner de vente
  });
  return {
    report: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}

/** Lignes de faits — UNIQUEMENT celles qui existent (jamais un zéro gonflé en argument). */
function factLines(report: TrialReportView, personality: 'pote' | 'pro' | 'direct'): string[] {
  const digest = report.digest;
  if (digest === null) return [];
  const lines: string[] = [];
  if (digest.collectedCents > 0) {
    lines.push(t('trial.reportCollected', { personality, params: { amount: formatEURWhole(digest.collectedCents) } }));
    if (digest.recoveredCents > 0) {
      lines.push(t('trial.reportRecovered', { personality, params: { amount: formatEURWhole(digest.recoveredCents) } }));
    }
  }
  if (digest.documentsCreated > 0) {
    lines.push(
      digest.documentsCreated === 1
        ? t('trial.reportDocumentsOne', { personality })
        : t('trial.reportDocuments', { personality, params: { count: digest.documentsCreated } }),
    );
    if (digest.documentsViaVoice > 0) {
      lines.push(t('trial.reportDocumentsVoice', { personality, params: { count: digest.documentsViaVoice } }));
    }
  }
  if (digest.relancesSent > 0) {
    lines.push(
      digest.relancesSent === 1
        ? t('trial.reportRelancesOne', { personality })
        : t('trial.reportRelances', { personality, params: { count: digest.relancesSent } }),
    );
  }
  if (digest.estimatedMinutesSaved > 0) {
    lines.push(t('trial.reportTimeSaved', { personality, params: { minutes: digest.estimatedMinutesSaved } }));
  }
  return lines;
}

export function TrialReportCard({ report }: { readonly report: TrialReportView }): React.JSX.Element | null {
  const { personality, colors, semantic } = useTheme();
  const router = useRouter();
  const trial = report.trial;
  // La carte n'existe qu'au TERME de l'essai : fin proche (décider sereinement) ou expiré
  // (atterrissage honnête). Jamais pendant la phase active — l'essai se vit, il ne se vend pas.
  if (trial === null || trial.phase === 'active') return null;

  const subtitle =
    trial.phase === 'ending_soon'
      ? t('trial.reportEndingSubtitle', { personality, params: { days: trial.daysLeft } })
      : t('trial.reportEndedSubtitle', { personality });
  const lines = factLines(report, personality);

  return (
    <Card padding={16}>
      <Text style={[font('eyebrow'), { fontSize: 10, color: colors.slate400 }]}>
        {t('trial.reportTitle', { personality })}
      </Text>
      <Text style={[font('sub'), { fontSize: 13, lineHeight: 18, color: colors.slate500, marginTop: 4 }]}>
        {subtitle}
      </Text>
      <View style={{ marginTop: 10, gap: 6 }}>
        {lines.length > 0 ? (
          lines.map((line) => (
            <View key={line} style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: semantic.success }} />
              <Text style={[font('body'), { fontSize: 14, lineHeight: 20, color: colors.ink900, flex: 1 }]}>
                {line}
              </Text>
            </View>
          ))
        ) : (
          <Text style={[font('sub'), { fontSize: 13, lineHeight: 18, color: colors.slate500 }]}>
            {t('trial.reportEmpty', { personality })}
          </Text>
        )}
      </View>
      <View style={{ height: 14 }} />
      <Button
        title={t('trial.reportCta', { personality })}
        variant="primary"
        onPress={() => router.push('/compte')}
      />
      <Text style={[font('meta'), { color: colors.slate500, lineHeight: 16, marginTop: 8 }]}>
        {t('trial.reportStayFree', { personality })}
      </Text>
    </Card>
  );
}

/** Intégration écran : la carte derrière le hook — invisible hors fin d'essai, sans condition à écrire. */
export function LatestTrialReportCard(): React.JSX.Element | null {
  const { personality } = useTheme();
  const query = useTrialReport();
  if (query.isLoading && query.report === null) return null;
  if (query.isError && query.report === null) {
    return (
      <ErrorRetry
        message={t('today.dataError', { personality })}
        onRetry={() => void query.refetch()}
      />
    );
  }
  const report = query.report;
  if (report === null || report.trial === null || report.trial.phase === 'active') return null;
  return (
    <View style={{ gap: 8 }}>
      {query.isError ? (
        <ErrorRetry
          message={t('today.dataError', { personality })}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      <TrialReportCard report={report} />
    </View>
  );
}
