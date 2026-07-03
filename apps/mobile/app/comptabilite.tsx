/**
 * Comptabilité — le grand-livre (claim C17). 100 % @bob/ui : rangée « Fermer » +
 * InnerScreenHeader (pattern écrans poussés, cf. notifications) → carte « Prêt pour le
 * comptable » (résumé dérivé summarizeAccountingEntries @bob/core — parité d'actions :
 * même use case pour Bob — + badge équilibre partie double + EXPORT FEC PARTAGEABLE :
 * le vrai fichier part au comptable via la feuille de partage native, repli toast) →
 * chips filtres par journal → écritures réelles (AccountingLinesView) → clôture du mois.
 * Paywall accounting_foundation conservé. Zéro hex, zéro fixture (doctrine A1-C10).
 */
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatEUR, summarizeAccountingEntries } from '@bob/core';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  Chip,
  InnerScreenHeader,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useAccountingEntries, useExportFec, useSubscription } from '../src/data/hooks';
import { shareFec } from '../src/lib/share-fec';
import { AccountingLinesView } from '../src/components/AccountingLinesView';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  LockIcon,
} from '../src/components/icons';

const JOURNAL_KEY: Record<string, I18nKey> = {
  sales: 'compta.journalSales',
  purchases: 'compta.journalPurchases',
  bank: 'compta.journalBank',
  misc: 'compta.journalMisc',
};
const JOURNAL_TONE: Record<string, StatusBadgeVariant> = {
  sales: 'b2b',
  purchases: 'particulier',
  bank: 'success',
  misc: 'b2g',
};

/** Date du jour AAAA-MM-JJ (DateOnly du core) — sans Intl, comme formatEUR. */
function todayISO(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso.slice(0, 10);
}

/** Skeleton d'un bloc pendant le chargement initial (même recette que Documents). */
function SkeletonBlock({ height }: { height: number }) {
  const { colors } = useTheme();
  return <View style={{ height, borderRadius: 18, backgroundColor: colors.lineSoft }} />;
}

export default function Comptabilite() {
  const { personality, colors, semantic, controls } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { data: sub } = useSubscription();
  const entries = useAccountingEntries();
  const exportFec = useExportFec();
  const entitled = (sub?.features ?? []).includes('accounting_foundation');
  const [filterJournal, setFilterJournal] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...(entries.data ?? [])].sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
    [entries.data],
  );
  const month = todayISO().slice(0, 7);
  // Résumé global (carte comptable, chips) et résumé filtré (bandeau de liste) — @bob/core.
  const summary = useMemo(() => summarizeAccountingEntries(sorted, { month }), [sorted, month]);
  const filteredSummary = useMemo(
    () => summarizeAccountingEntries(sorted, { month, journal: filterJournal }),
    [sorted, month, filterJournal],
  );
  const filtered = useMemo(
    () => (filterJournal ? sorted.filter((e) => e.journal === filterJournal) : sorted),
    [sorted, filterJournal],
  );

  const runExport = (): void => {
    // Le FEC couvre l'exercice en cours (1er janvier → aujourd'hui), pas le mois seul.
    const today = todayISO();
    exportFec.mutate(
      { from: `${today.slice(0, 4)}-01-01`, to: today },
      {
        onSuccess: (out) => {
          // Le VRAI fichier part au comptable ; si le partage est indisponible, on garde
          // le toast honnête de génération (le FEC existe, l'envoi attendra).
          void shareFec(out).then((r) => {
            if (r === 'unavailable')
              setToast(t('docs.exportDone', { personality, params: { filename: out.filename } }));
          });
        },
        onError: () => setToast(t('docs.exportError', { personality })),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ paddingTop: insets.top + 10, paddingHorizontal: 16 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('compta.back', { personality })}
          onPress={() => router.back()}
          hitSlop={8}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
        >
          <ChevronLeftIcon color={colors.ink800} size={18} strokeWidth={2.2} />
          <Text style={[font('label', 600), { fontSize: 15, color: colors.ink800 }]}>
            {t('compta.back', { personality })}
          </Text>
        </Pressable>
      </View>

      <InnerScreenHeader
        eyebrow={t('compta.eyebrow', { personality })}
        title={t('compta.title', { personality })}
        subtitle={t('compta.subtitle', { personality })}
      />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: insets.bottom + 34, gap: 12 }}
        showsVerticalScrollIndicator={false}
      >
        {!entitled ? (
          <Card>
            <Text style={[font('cardTitle'), { color: colors.ink900 }]}>
              {t('compta.paywallTitle', { personality })}
            </Text>
            <Text style={[font('sub'), { color: colors.slate500, marginTop: 6, lineHeight: 19 }]}>
              {t('compta.paywallBody', { personality })}
            </Text>
            <View style={{ height: 12 }} />
            <Button
              title={t('compta.paywallCta', { personality })}
              variant="secondary"
              onPress={() => router.push('/compte')}
            />
          </Card>
        ) : entries.isLoading ? (
          <>
            <SkeletonBlock height={130} />
            <SkeletonBlock height={170} />
            <SkeletonBlock height={170} />
          </>
        ) : entries.isError ? (
          <Card>
            <Text accessibilityRole="alert" style={[font('sub'), { color: colors.slate500 }]}>
              {t('compta.dataError', { personality })}
            </Text>
            <View style={{ height: 12 }} />
            <Button
              title={t('compta.retry', { personality })}
              variant="secondary"
              onPress={() => void entries.refetch()}
            />
          </Card>
        ) : (
          <>
            {/* Prêt pour le comptable — résumé dérivé + équilibre + export PARTAGEABLE */}
            <Card>
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                <View
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    backgroundColor: semantic.successBg,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <ClipboardCheckIcon color={semantic.success} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Text style={{ ...font('body', 700), fontSize: 14, color: colors.ink800 }}>
                      {t('compta.summaryTitle', { personality })}
                    </Text>
                    <StatusBadge
                      label={t(summary.balanced ? 'compta.balanced' : 'compta.unbalanced', { personality })}
                      variant={summary.balanced ? 'success' : 'danger'}
                    />
                  </View>
                  <Text style={{ ...font('sub', 500), fontSize: 12.5, color: colors.slate500, marginTop: 3, lineHeight: 18 }}>
                    {summary.currentMonthCount === 1
                      ? t('compta.entriesMonthOne', { personality })
                      : t('compta.entriesMonth', { personality, params: { count: summary.currentMonthCount } })}
                    {' · '}
                    {t('compta.totalsLine', {
                      personality,
                      params: { debit: formatEUR(summary.totalDebitCents), credit: formatEUR(summary.totalCreditCents) },
                    })}
                  </Text>
                </View>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('docs.exportCta', { personality })}
                disabled={exportFec.isPending || summary.entryCount === 0}
                onPress={runExport}
                style={({ pressed }) => [
                  {
                    marginTop: 13,
                    backgroundColor: semantic.success,
                    borderRadius: 12,
                    paddingVertical: 12,
                    alignItems: 'center',
                    minHeight: 44,
                    justifyContent: 'center',
                    opacity: exportFec.isPending || summary.entryCount === 0 ? 0.5 : pressed ? 0.9 : 1,
                  },
                ]}
              >
                <Text style={{ ...font('body', 700), fontSize: 14, color: colors.surface }}>
                  {t('docs.exportCta', { personality })}
                </Text>
              </Pressable>
            </Card>

            {sorted.length === 0 ? (
              <Card>
                <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                  {t('compta.empty', { personality })}
                </Text>
              </Card>
            ) : (
              <>
                {summary.byJournal.length > 1 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    <Chip
                      label={t('compta.chipAll', { personality })}
                      active={filterJournal === null}
                      onPress={() => setFilterJournal(null)}
                    />
                    {summary.byJournal.map(({ journal }) => (
                      <Chip
                        key={journal}
                        label={t(JOURNAL_KEY[journal] ?? 'compta.journalMisc', { personality })}
                        active={filterJournal === journal}
                        onPress={() => setFilterJournal(journal)}
                      />
                    ))}
                  </View>
                ) : null}

                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 2 }}>
                  <Text style={[font('meta'), { color: colors.slate400 }]}>
                    {filteredSummary.entryCount === 1
                      ? t('compta.entriesCountOne', { personality })
                      : t('compta.entriesCount', { personality, params: { count: filteredSummary.entryCount } })}
                  </Text>
                  <Text style={{ ...font('meta'), color: colors.slate500, fontVariant: ['tabular-nums'] }}>
                    {t('compta.totalsLine', {
                      personality,
                      params: {
                        debit: formatEUR(filteredSummary.totalDebitCents),
                        credit: formatEUR(filteredSummary.totalCreditCents),
                      },
                    })}
                  </Text>
                </View>

                {filtered.map((entry) => (
                  <Card key={entry.id}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <View style={{ flex: 1, paddingRight: 12 }}>
                        <Text style={{ ...font('cardTitle'), color: colors.ink900, fontVariant: ['tabular-nums'] }}>
                          {entry.reference}
                        </Text>
                        <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]} numberOfLines={1}>
                          {entry.label}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end', gap: 6 }}>
                        <StatusBadge
                          label={t(JOURNAL_KEY[entry.journal] ?? 'compta.journalMisc', { personality })}
                          variant={JOURNAL_TONE[entry.journal] ?? 'b2g'}
                        />
                        <Text style={[font('meta'), { color: colors.slate400 }]}>{formatDate(entry.entryDate)}</Text>
                      </View>
                    </View>
                    <View style={{ marginTop: 10 }}>
                      <AccountingLinesView lines={entry.lines} />
                    </View>
                  </Card>
                ))}
              </>
            )}

            {/* Clôture du mois — écran réel existant */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('compta.closeCta', { personality })}
              onPress={() => router.push('/cloture')}
            >
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                    <LockIcon color={colors.ink800} size={15} strokeWidth={2} />
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>
                      {t('compta.closeCta', { personality })}
                    </Text>
                  </View>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </View>
              </Card>
            </Pressable>
          </>
        )}
      </ScrollView>

      <Toast
        message={toast ?? ''}
        visible={toast !== null}
        onHide={() => setToast(null)}
        icon={<CheckIcon color={colors.surface} />}
      />
    </View>
  );
}
