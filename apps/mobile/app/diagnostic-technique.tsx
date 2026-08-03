/**
 * Diagnostic TECHNIQUE (SPEC_SYSTEME_ERREUR §5.2) — la face développeur accessible SANS les
 * logs serveur : les derniers échecs API (code court, corrélation, heure, route expurgée,
 * statut) + l'état du canal de crash de CE build. Route distincte de `/diagnostic`, qui reste
 * le diagnostic COMPTABLE (score du dossier).
 *
 * Sobriété assumée : lecture seule, partage en un geste (texte composé SANS PII — le journal
 * n'a par construction ni cause, ni message, ni donnée client), et purge locale. Zéro hex :
 * useTheme()/@bob/tokens uniquement.
 *
 * Vague hors-lots (audit 03/08) : header FIXE hors du scroll (anatomie des écrans frères),
 * journal non lu ≠ journal vide (jamais « aucun échec » avant la première lecture), purge via
 * ConfirmSheet kit et échec de partage en Toast danger — la grammaire d'erreur de la maison
 * ne s'arrête pas aux écrans support.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import { BackHeader, Button, Card, SectionHeader, Skeleton, Toast, font, useTheme } from '@bob/ui';
import { shortCorrelationId } from '@bob/api-client';
import {
  ERROR_JOURNAL_MAX_ENTRIES,
  clearJournal,
  journalEntryTime,
  journalShareText,
  readJournal,
  type ErrorJournalEntry,
} from '../src/data/error-journal';
import { resolveCrashReporterConfig } from '../src/observability/crash-reporter';
import { useConfirm } from '../src/components/ConfirmSheet';

function JournalRow({ entry, isLast }: { entry: ErrorJournalEntry; isLast: boolean }) {
  const { colors, personality } = useTheme();
  const time = journalEntryTime(entry.at);
  const statusLine =
    entry.status === null
      ? t('diagtech.noResponse', { personality })
      : t('diagtech.httpStatus', { personality, params: { status: entry.status } });
  return (
    <View
      // `accessible` rend le label composé RÉELLEMENT annoncé (une View nue ne regroupe pas
      // ses enfants pour VoiceOver/TalkBack — le résumé restait lu morceau par morceau).
      accessible
      accessibilityLabel={`${entry.code}, ${time}, ${entry.method} ${entry.path}, ${statusLine}`}
      style={{
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: colors.lineSoft,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[font('sub', 700), { color: colors.ink800 }]}>{entry.code}</Text>
        <Text style={[font('meta'), { color: colors.slate400 }]}>{time}</Text>
      </View>
      <Text style={[font('meta'), { color: colors.slate500, marginTop: 2 }]}>
        {entry.method} {entry.path}
      </Text>
      <Text selectable style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
        {entry.correlationId ? shortCorrelationId(entry.correlationId) : '—'}
        {' · '}
        {statusLine}
      </Text>
    </View>
  );
}

/** Silhouette d'UNE rangée de journal pendant la lecture async — jamais « aucun échec ». */
function JournalRowSkeleton() {
  return (
    <View style={{ paddingVertical: 10, gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Skeleton height={13} width="34%" radius={6} />
        <Skeleton height={11} width="18%" radius={6} />
      </View>
      <Skeleton height={11} width="58%" radius={6} />
    </View>
  );
}

export default function DiagnosticTechniqueScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, personality } = useTheme();
  const confirm = useConfirm();
  const say = useCallback(
    (key: I18nKey, params?: Readonly<Record<string, string | number>>): string =>
      t(key, { personality, ...(params ? { params } : {}) }),
    [personality],
  );

  // `null` = journal PAS ENCORE LU (lecture async) : une source absente n'est jamais une
  // collection vide — l'écran n'affirme « aucun échec » qu'après la première résolution.
  const [entries, setEntries] = useState<readonly ErrorJournalEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dangerToast, setDangerToast] = useState<string | null>(null);
  // Résolu UNE fois : dit si le canal de crash de CE build est vivant (DSN UE hors dev).
  const crashChannelActive = useMemo(() => resolveCrashReporterConfig() !== null, []);

  const reload = useCallback(async () => {
    setEntries(await readJournal());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const onShare = useCallback(async () => {
    try {
      await Share.share({ message: journalShareText(entries ?? []) });
    } catch {
      // Échec éphémère non actionnable → Toast danger (grammaire d'erreur, jamais Alert).
      setDangerToast(say('diagtech.shareUnavailable'));
    }
  }, [entries, say]);

  const onClear = useCallback(async () => {
    // ConfirmSheet kit (challenge tap, destructive) — même feuille que les flux manuel/vocal.
    const accepted = await confirm({
      title: say('diagtech.clearConfirmTitle'),
      message: say('diagtech.clearConfirmBody'),
      challenge: { kind: 'tap' },
      destructive: true,
    });
    if (!accepted) return;
    await clearJournal();
    await reload();
  }, [confirm, reload, say]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Header FIXE hors du scroll — l'anatomie des écrans frères (le retour ne disparaît
          jamais au défilement), BackHeader kit importé directement de @bob/ui. */}
      <BackHeader
        backLabel={say('reglages.back')}
        onBack={() => router.back()}
        eyebrow={say('diagtech.eyebrow')}
        title={say('diagtech.title')}
        subtitle={say('diagtech.subtitle')}
      />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.gutter,
          paddingTop: 14,
          paddingBottom: insets.bottom + 28,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ink800}
            colors={[colors.ink800]}
          />
        }
      >
        <SectionHeader title={say('diagtech.channelTitle')} />
        <Card padding={15} style={{ marginBottom: 16 }}>
          <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]}>
            {say(crashChannelActive ? 'diagtech.channelActive' : 'diagtech.channelDormant')}
          </Text>
        </Card>

        <SectionHeader title={say('diagtech.sectionJournal')} />
        <Card padding={15} style={{ marginBottom: 12 }}>
          {entries === null ? (
            <JournalRowSkeleton />
          ) : entries.length === 0 ? (
            <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
              {say('diagtech.empty')}
            </Text>
          ) : (
            <>
              <Text style={[font('meta'), { color: colors.slate400, marginBottom: 4 }]}>
                {say('diagtech.statusLine', {
                  count: entries.length,
                  max: ERROR_JOURNAL_MAX_ENTRIES,
                })}
              </Text>
              {entries.map((item, index) => (
                <JournalRow
                  key={`${item.at}-${item.code}-${index}`}
                  entry={item}
                  isLast={index === entries.length - 1}
                />
              ))}
            </>
          )}
        </Card>

        {entries !== null && entries.length > 0 ? (
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button
              title={say('diagtech.share')}
              variant="primary"
              style={{ flex: 1 }}
              onPress={() => void onShare()}
            />
            <Button
              title={say('diagtech.clear')}
              variant="secondary"
              style={{ flex: 1 }}
              onPress={() => void onClear()}
            />
          </View>
        ) : null}
      </ScrollView>

      <Toast
        message={dangerToast ?? ''}
        visible={dangerToast !== null}
        tone="danger"
        onHide={() => setDangerToast(null)}
      />
    </View>
  );
}
