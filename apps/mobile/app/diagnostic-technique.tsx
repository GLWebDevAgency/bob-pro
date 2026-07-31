/**
 * Diagnostic TECHNIQUE (SPEC_SYSTEME_ERREUR §5.2) — la face développeur accessible SANS les
 * logs serveur : les derniers échecs API (code court, corrélation, heure, route expurgée,
 * statut) + l'état du canal de crash de CE build. Route distincte de `/diagnostic`, qui reste
 * le diagnostic COMPTABLE (score du dossier).
 *
 * Sobriété assumée : lecture seule, partage en un geste (texte composé SANS PII — le journal
 * n'a par construction ni cause, ni message, ni donnée client), et purge locale. Zéro hex :
 * useTheme()/@bob/tokens uniquement.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, Share, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t, type I18nKey } from '@bob/i18n';
import { Button, Card, SectionHeader, font, useTheme } from '@bob/ui';
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
import { ScreenHeader } from '../src/components/screen-header';

function JournalRow({ entry, isLast }: { entry: ErrorJournalEntry; isLast: boolean }) {
  const { colors, controls } = useTheme();
  const time = journalEntryTime(entry.at);
  return (
    <View
      accessibilityLabel={`${entry.code}, ${time}, ${entry.method} ${entry.path}`}
      style={{
        paddingVertical: 10,
        borderBottomWidth: isLast ? 0 : 1,
        borderBottomColor: controls.cardBorder,
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
        {entry.status === null ? 'sans réponse' : `HTTP ${entry.status}`}
      </Text>
    </View>
  );
}

export default function DiagnosticTechniqueScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors, personality } = useTheme();
  const say = useCallback(
    (key: I18nKey, params?: Readonly<Record<string, string | number>>): string =>
      t(key, { personality, ...(params ? { params } : {}) }),
    [personality],
  );

  const [entries, setEntries] = useState<readonly ErrorJournalEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
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
      await Share.share({ message: journalShareText(entries) });
    } catch {
      Alert.alert(say('diagtech.shareUnavailable'));
    }
  }, [entries, say]);

  const onClear = useCallback(() => {
    Alert.alert(say('diagtech.clearConfirmTitle'), say('diagtech.clearConfirmBody'), [
      { text: t('common.cancel', { personality }), style: 'cancel' },
      {
        text: say('diagtech.clearConfirmYes'),
        style: 'destructive',
        onPress: () => {
          void clearJournal().then(reload);
        },
      },
    ]);
  }, [personality, reload, say]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: 18,
          paddingBottom: insets.bottom + 28,
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <ScreenHeader
          backLabel={say('reglages.back')}
          onBack={() => router.back()}
          eyebrow={say('diagtech.eyebrow')}
          title={say('diagtech.title')}
          subtitle={say('diagtech.subtitle')}
        />

        <SectionHeader title={say('diagtech.channelTitle')} />
        <Card padding={15} style={{ marginBottom: 16 }}>
          <Text style={[font('sub'), { color: colors.ink800, lineHeight: 19 }]}>
            {say(crashChannelActive ? 'diagtech.channelActive' : 'diagtech.channelDormant')}
          </Text>
        </Card>

        <SectionHeader title={say('diagtech.sectionJournal')} />
        <Card padding={15} style={{ marginBottom: 12 }}>
          {entries.length === 0 ? (
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

        {entries.length > 0 ? (
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
              onPress={onClear}
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
