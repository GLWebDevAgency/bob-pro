/**
 * Comptabilité — le grand-livre (claim C17, parité stricte A3-C17 sur la réf
 * « Bob Pro.dc.html » §COMPTABILITÉ). Structure de la réf : la PAGE ENTIÈRE défile ;
 * seule la rangée retour « ‹ Documents » est sticky (fond bg à .92 — token
 * patterns.bottomTabBar.fade[1] ; le backdrop-blur CSS n'a pas d'équivalent RN sans
 * dépendance, l'opacité .92 assure la lisibilité). L'en-tête (eyebrow/titre/sous-titre)
 * DÉFILE avec le contenu (réf : padding 2/20/4 — pas d'InnerScreenHeader ici, son
 * paddingTop 56 est le gabarit des onglets sans rangée retour).
 * Puis : HÉROS vert vault.monthReady radius 20 (équation Débit = Crédit 20px
 * Schibsted-800, signe 23px success/dangerVivid — LA signature) + export FEC
 * PARTAGEABLE → « Le journal » + chips par journal → bandeau contextuel filtré →
 * écritures (IconTile teintée, hairline, AccountingLinesView) → clôture → footer.
 * Résumés dérivés par summarizeAccountingEntries (@bob/core — l'écran ne calcule rien).
 * Paywall accounting_foundation conservé — via la fondation monetization (useEntitlement +
 * PaywallCard contextuelle, jamais pendant le chargement). Zéro hex, zéro fixture.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { formatEUR, summarizeAccountingEntries } from '@bob/core';
import { patterns, vault } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Card,
  Chip,
  EmptyState,
  ErrorRetry,
  IconTile,
  SectionHeader,
  SkeletonCard,
  StatusBadge,
  Toast,
  font,
  useTheme,
  type StatusBadgeVariant,
} from '@bob/ui';
import { useAccountingEntries, useExportFec } from '../src/data/hooks';
import { PaywallCard, useEntitlement } from '../src/monetization/paywall';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { shareFec } from '../src/lib/share-fec';
import { AccountingLinesView } from '../src/components/AccountingLinesView';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';
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

/** Colonne de l'équation partie double : label eyebrow + montant tabular (réf : 20px/800). */
function EquationSide({ label, cents, align }: { label: string; cents: number; align: 'left' | 'right' }) {
  const { colors } = useTheme();
  const alignItems = align === 'left' ? ('flex-start' as const) : ('flex-end' as const);
  return (
    <View style={{ flex: 1, alignItems }}>
      <Text style={[font('eyebrow'), { letterSpacing: 0.4, color: colors.slate400 }]}>{label}</Text>
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
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  // Entitlement TYPÉ (fondation paywall) — même feature que le gating historique de l'écran.
  const entitlement = useEntitlement('accounting_foundation');
  const entries = useAccountingEntries();
  const exportFec = useExportFec();
  const entitled = entitlement.allowed;
  const [filterJournal, setFilterJournal] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...(entries.data ?? [])].sort((a, b) => b.entryDate.localeCompare(a.entryDate)),
    [entries.data],
  );
  // Bob voit le journal AFFICHÉ : « explique cette écriture » — lecture seule.
  const agentContext = useMemo<AgentContext>(
    () => {
      const canExposeAccounting =
        entitlement.verified && entitled && !entries.isError && entries.data !== undefined;
      return {
        screen: { name: 'comptabilite', instanceId: 'comptabilite' },
        entities: canExposeAccounting
          ? sorted.slice(0, 10).map((entry) => ({
              type: 'accounting_entry' as const,
              id: entry.id,
              label: `${entry.reference} — ${entry.label}`,
            }))
          : [],
        capabilities: canExposeAccounting ? ['screen.read', 'accounting.read'] : [],
      };
    },
    [entitlement.verified, entitled, entries.data, entries.isError, sorted],
  );
  usePublishAgentContext(agentContext);

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

  /** Icône du journal, teintée comme sa pastille (mêmes sémantiques que la réf). */
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
      <ScrollView
        style={{ flex: 1 }}
        stickyHeaderIndices={[0]}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bobScrollInsets.paddingBottom }}
        automaticallyAdjustKeyboardInsets={bobScrollInsets.automaticallyAdjustKeyboardInsets}
        scrollIndicatorInsets={{ bottom: bobScrollInsets.scrollIndicatorBottom }}
      >
        {/* [0] Rangée retour — SEUL élément sticky (réf : bg .92, « ‹ Documents » b2b).
            Divergence deep-link assumée : ouvert depuis le briefing, back() y retourne. */}
        <View
          style={{
            paddingTop: insets.top + 10,
            paddingHorizontal: 16,
            paddingBottom: 8,
            backgroundColor: patterns.bottomTabBar.fade[1],
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('compta.back', { personality })}
            onPress={() => router.back()}
            hitSlop={8}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', minHeight: 34 }}
          >
            <ChevronLeftIcon color={semantic.b2b} size={19} strokeWidth={2.2} />
            <Text style={[font('label', 600), { fontSize: 15, color: semantic.b2b }]}>
              {t('compta.back', { personality })}
            </Text>
          </Pressable>
        </View>

        {/* En-tête — DÉFILE avec le contenu (réf : padding 2/20/4). */}
        <View style={{ paddingTop: 2, paddingHorizontal: 20, paddingBottom: 4 }}>
          <Text style={[font('eyebrow'), { color: colors.slate400 }]}>{t('compta.eyebrow', { personality })}</Text>
          <Text style={[font('pageTitle'), { color: colors.ink800, marginTop: 2 }]} accessibilityRole="header">
            {t('compta.title', { personality })}
          </Text>
          <Text style={[font('body'), { color: colors.slate500, marginTop: 3 }]}>
            {t('compta.subtitle', { personality })}
          </Text>
        </View>

        {/* Abonnement en chargement → squelettes, JAMAIS le paywall (fail-open d'affichage) ;
            verrouillé → carte contextuelle du domaine (même emplacement que le contenu) ;
            decision 'unavailable' (aucun catalogue ne vend la capacité) → PaywallCard rend
            null PAR CONSTRUCTION (paywall.tsx) : repli EmptyState pour ne jamais laisser
            l'écran vide (P2 audit 14/07). */}
        {!entitlement.loading && !entitled ? (
          entitlement.decision !== null ? (
            <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
              {entitlement.decision.kind === 'unavailable' ? (
                <Card>
                  <EmptyState
                    title={t('compta.paywallTitle', { personality })}
                    body={t('compta.paywallBody', { personality })}
                  />
                </Card>
              ) : (
                <PaywallCard
                  decision={entitlement.decision}
                  source="feature_screen"
                  personality={personality}
                  onDismissed={() => router.back()}
                />
              )}
            </View>
          ) : null
        ) : entitlement.loading || entries.isLoading ? (
          <View style={{ paddingTop: 16, paddingHorizontal: 18, gap: 12 }}>
            <SkeletonCard height={190} contentLines={4} />
            <SkeletonCard height={150} contentLines={3} />
            <SkeletonCard height={150} contentLines={3} />
          </View>
        ) : entries.isError ? (
          <View style={{ paddingTop: 16, paddingHorizontal: 18 }}>
            {/* Socle ErrorRetry (bord danger + pending visible) — plus de carte d'échec locale. */}
            <ErrorRetry
              message={t('compta.dataError', { personality })}
              onRetry={() => void entries.refetch()}
              retrying={entries.isRefetching}
            />
          </View>
        ) : (
          <>
            {/* HÉROS « Prêt pour le comptable » (réf : marges 16/18, radius 20) —
                équation de la partie double en signature, export FEC partageable. */}
            <LinearGradient
              colors={[vault.monthReadyTop, vault.monthReadyBottom]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{
                marginTop: 16,
                marginHorizontal: 18,
                borderRadius: 20,
                borderWidth: 1,
                borderColor: vault.monthReadyBorder,
                padding: 16,
              }}
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
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 }}>
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
                    marginTop: 16,
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
              <View style={{ paddingTop: 12, paddingHorizontal: 18 }}>
                <Card>
                  <EmptyState body={t('compta.empty', { personality })} />
                </Card>
              </View>
            ) : (
              <>
                {/* « Le journal » (réf : padding 22/20/12) */}
                <View style={{ paddingTop: 22, paddingHorizontal: 20 }}>
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
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 18, paddingBottom: 4 }}>
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

                {/* Bandeau contextuel (réf : padding 10/20/2) — sous-ensemble filtré uniquement. */}
                {filterJournal !== null ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      paddingTop: 10,
                      paddingHorizontal: 20,
                      paddingBottom: 2,
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

                {/* Écritures (réf : padding 10/18/0, gap 11, cartes padding 15) */}
                <View style={{ paddingTop: 10, paddingHorizontal: 18, gap: 11 }}>
                  {filtered.map((entry) => (
                    <Card key={entry.id} padding={15}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 11 }}>
                        <IconTile tone={JOURNAL_TONE[entry.journal] ?? 'b2g'} size={34} radius={10}>
                          {journalIcon(entry.journal)}
                        </IconTile>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text
                            style={{ ...font('cardTitle'), color: colors.ink800, fontVariant: ['tabular-nums'] }}
                            numberOfLines={1}
                          >
                            {entry.reference}
                          </Text>
                          <Text style={[font('meta'), { color: colors.slate300, marginTop: 2 }]} numberOfLines={1}>
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

            {/* Clôture du mois (réf : padding 12/18/0, carte 15) */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('compta.closeCta', { personality })}
              onPress={() => router.push('/cloture')}
              style={{ paddingTop: 12, paddingHorizontal: 18 }}
            >
              <Card padding={15}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 11 }}>
                  <IconTile tone="b2g" size={34} radius={10}>
                    <LockIcon color={semantic.b2g} size={15} strokeWidth={2} />
                  </IconTile>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('cardTitle'), { color: colors.ink800 }]}>
                      {t('compta.closeCta', { personality })}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate300, marginTop: 2 }]} numberOfLines={1}>
                      {t('compta.closeSub', { personality })}
                    </Text>
                  </View>
                  <ChevronRightIcon color={controls.chevron} size={14} strokeWidth={2} />
                </View>
              </Card>
            </Pressable>

            {/* Footer voix de Bob (réf : padding 22/30/8) */}
            <Text
              style={[
                font('meta', 500),
                {
                  fontSize: 12.5,
                  color: colors.slate300,
                  textAlign: 'center',
                  paddingTop: 22,
                  paddingHorizontal: 30,
                  paddingBottom: 8,
                },
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
