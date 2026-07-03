/**
 * Comptabilité — le grand-livre (claim C17, refonte DA A1-C17). 100 % @bob/ui :
 * rangée « Fermer » + InnerScreenHeader (pattern écrans poussés) → HÉROS dégradé vert
 * « Prêt pour le comptable » (recette vault.monthReady de Documents — dans l'app,
 * « compta prête » = vert succès) avec la SIGNATURE visuelle de l'écran : l'équation de
 * la partie double (Débit = Crédit en tabular-nums, « = » succès / « ≠ » danger) +
 * export FEC PARTAGEABLE (feuille de partage native, repli toast) → SectionHeader
 * « Le journal » + chips par journal → écritures réelles (IconTile teintée par journal,
 * hairline, AccountingLinesView) → clôture → footer voix de Bob.
 * Résumés dérivés par summarizeAccountingEntries (@bob/core — parité d'actions, l'écran
 * ne calcule rien). Paywall accounting_foundation conservé. Zéro hex, zéro fixture.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { formatEUR, summarizeAccountingEntries } from '@bob/core';
import { vault } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Button,
  Card,
  Chip,
  IconTile,
  InnerScreenHeader,
  SectionHeader,
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
  ChartIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  DepositIcon,
  FileTextIcon,
  LockIcon,
  WalletIcon,
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

/** Colonne de l'équation partie double : label eyebrow + montant tabular. */
function EquationSide({ label, cents, align }: { label: string; cents: number; align: 'left' | 'right' }) {
  const { colors } = useTheme();
  const alignItems = align === 'left' ? ('flex-start' as const) : ('flex-end' as const);
  return (
    <View style={{ flex: 1, alignItems }}>
      <Text style={[font('eyebrow'), { letterSpacing: 0.4, color: colors.slate500 }]}>{label}</Text>
      <Text
        style={{ ...font('bigNum'), fontSize: 20, color: colors.ink900, marginTop: 2, fontVariant: ['tabular-nums'] }}
        numberOfLines={1}
      >
        {formatEUR(cents)}
      </Text>
    </View>
  );
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
  // Résumé global (héros, chips) et résumé filtré (bandeau contextuel) — @bob/core.
  const summary = useMemo(() => summarizeAccountingEntries(sorted, { month }), [sorted, month]);
  const filteredSummary = useMemo(
    () => summarizeAccountingEntries(sorted, { month, journal: filterJournal }),
    [sorted, month, filterJournal],
  );
  const filtered = useMemo(
    () => (filterJournal ? sorted.filter((e) => e.journal === filterJournal) : sorted),
    [sorted, filterJournal],
  );

  /** Icône du journal, teintée comme sa pastille (mêmes sémantiques que la tab Documents). */
  const journalIcon = (journal: string): ReactNode => {
    switch (journal) {
      case 'sales':
        return <FileTextIcon color={semantic.b2b} size={16} />;
      case 'purchases':
        return <WalletIcon color={semantic.particulier} size={17} strokeWidth={2} />;
      case 'bank':
        return <DepositIcon color={semantic.success} size={16} />;
      default:
        return <ChartIcon color={semantic.b2g} size={16} />;
    }
  };

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
        contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: insets.bottom + 34 }}
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
          <View style={{ gap: 12 }}>
            <SkeletonBlock height={170} />
            <SkeletonBlock height={150} />
            <SkeletonBlock height={150} />
          </View>
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
            {/* HÉROS « Prêt pour le comptable » — dégradé vert (recette mois prêt de Documents),
                équation de la partie double en signature, export FEC partageable. */}
            <LinearGradient
              colors={[vault.monthReadyTop, vault.monthReadyBottom]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{ borderRadius: 18, borderWidth: 1, borderColor: vault.monthReadyBorder, padding: 16 }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                <IconTile tone="success" size={34} radius={10}>
                  <ClipboardCheckIcon color={semantic.success} />
                </IconTile>
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
                  <Text style={{ ...font('sub', 500), fontSize: 12.5, color: colors.slate500, marginTop: 2 }}>
                    {summary.currentMonthCount === 1
                      ? t('compta.entriesMonthOne', { personality })
                      : t('compta.entriesMonth', { personality, params: { count: summary.currentMonthCount } })}
                  </Text>
                </View>
              </View>

              {/* L'équation : la partie double tient (=) ou ne tient pas (≠) — au centime. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 15 }}>
                <EquationSide label={t('compta.debitLabel', { personality })} cents={summary.totalDebitCents} align="left" />
                <Text
                  accessibilityLabel={t(summary.balanced ? 'compta.balanced' : 'compta.unbalanced', { personality })}
                  style={{
                    ...font('bigNum'),
                    fontSize: 23,
                    color: summary.balanced ? semantic.success : semantic.dangerVivid,
                  }}
                >
                  {summary.balanced ? '=' : '≠'}
                </Text>
                <EquationSide label={t('compta.creditLabel', { personality })} cents={summary.totalCreditCents} align="right" />
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('docs.exportCta', { personality })}
                disabled={exportFec.isPending || summary.entryCount === 0}
                onPress={runExport}
                style={({ pressed }) => [
                  {
                    marginTop: 15,
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
            </LinearGradient>

            {sorted.length === 0 ? (
              <View style={{ marginTop: 12 }}>
                <Card>
                  <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                    {t('compta.empty', { personality })}
                  </Text>
                </Card>
              </View>
            ) : (
              <>
                <View style={{ marginTop: 22 }}>
                  <SectionHeader
                    title={t('compta.sectionJournal', { personality })}
                    action={
                      <Text style={[font('label'), { color: colors.slate400 }]}>
                        {summary.entryCount === 1
                          ? t('compta.entriesCountOne', { personality })
                          : t('compta.entriesCount', { personality, params: { count: summary.entryCount } })}
                      </Text>
                    }
                  />
                </View>

                {summary.byJournal.length > 1 ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
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

                {/* Bandeau contextuel : compte + totaux du sous-ensemble filtré uniquement. */}
                {filterJournal !== null ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      paddingHorizontal: 2,
                      marginBottom: 10,
                    }}
                  >
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
                ) : null}

                <View style={{ gap: 11 }}>
                  {filtered.map((entry) => (
                    <Card key={entry.id}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                        <IconTile tone={JOURNAL_TONE[entry.journal] ?? 'b2g'} size={34} radius={10}>
                          {journalIcon(entry.journal)}
                        </IconTile>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={{ ...font('cardTitle'), color: colors.ink900, fontVariant: ['tabular-nums'] }}
                            numberOfLines={1}
                          >
                            {entry.reference}
                          </Text>
                          <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]} numberOfLines={1}>
                            {entry.label} · {formatDate(entry.entryDate)}
                          </Text>
                        </View>
                        <StatusBadge
                          label={t(JOURNAL_KEY[entry.journal] ?? 'compta.journalMisc', { personality })}
                          variant={JOURNAL_TONE[entry.journal] ?? 'b2g'}
                        />
                      </View>
                      <View
                        style={{
                          marginTop: 12,
                          paddingTop: 10,
                          borderTopWidth: 1,
                          borderTopColor: colors.lineSoft,
                        }}
                      >
                        <AccountingLinesView lines={entry.lines} />
                      </View>
                    </Card>
                  ))}
                </View>
              </>
            )}

            {/* Clôture du mois — écran réel existant */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('compta.closeCta', { personality })}
              onPress={() => router.push('/cloture')}
              style={{ marginTop: 12 }}
            >
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <IconTile tone="b2g" size={34} radius={10}>
                    <LockIcon color={semantic.b2g} size={15} strokeWidth={2} />
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('cardTitle'), { color: colors.ink900 }]}>
                      {t('compta.closeCta', { personality })}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]} numberOfLines={1}>
                      {t('compta.closeSub', { personality })}
                    </Text>
                  </View>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </View>
              </Card>
            </Pressable>

            <Text
              style={[
                font('meta', 500),
                { color: colors.slate300, textAlign: 'center', paddingTop: 22, paddingBottom: 8 },
              ]}
            >
              {t('compta.footer', { personality })}
            </Text>
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
