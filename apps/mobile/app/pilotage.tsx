/**
 * Pilotage (BA-3) — la revue business de l'indépendant : mois en cours (facturé HT vs
 * encaissé TTC à isopérimètre), tendance mois clos + cumul annuel, série mensuelle, DSO,
 * top clients, top postes de dépense, cascade SIG avec ratios. TOUT dérive de
 * deriveBusinessReview (@bob/core) — mêmes chiffres que Bob (getBusinessReview, parité).
 * Pattern écran poussé (A3-C17) : rangée retour sticky + InnerScreenHeader. Honnêteté
 * d'affichage : jamais de % plein-mois sur le mois courant, « — » plutôt qu'un % trompeur,
 * états null assumés (DSO sous 3 mois d'historique). Zéro hex, i18n pilotage.* ×3 humeurs.
 */
import { useMemo, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import {
  deriveBusinessReview,
  formatEUR,
  type BusinessReview,
  type ExpenseCategory,
} from '@bob/core';
import { shadowComponentsNative, vault } from '@bob/tokens';
import { t, type I18nKey } from '@bob/i18n';
import {
  Card,
  EmptyState,
  ErrorRetry,
  InnerScreenHeader,
  MoneyText,
  SectionHeader,
  SkeletonCard,
  StaggeredList,
  StatusBadge,
  StickyBackRow,
  TrendBars,
  font,
  useTheme,
} from '@bob/ui';
import {
  useAccountingEntries,
  useCompany,
  useCustomers,
  useExpenses,
  useInvoices,
  usePayments,
} from '../src/data/hooks';
import { PaywallCard, useEntitlement } from '../src/monetization/paywall';
import { combineQueryStates } from '../src/data/query-state';
import { usePublishAgentContext, type AgentContext } from '../src/agent';
import { ChevronRightIcon } from '../src/components/icons';
import { useBobAwareScrollInsets } from '../src/components/use-bob-aware-scroll-insets';

const MONTHS = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

const CAT_KEY: Record<ExpenseCategory, I18nKey> = {
  fournitures: 'dep.catFournitures',
  materiel: 'dep.catMateriel',
  carburant: 'dep.catCarburant',
  repas: 'dep.catRepas',
  sous_traitance: 'dep.catSousTraitance',
  autre: 'dep.catAutre',
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** Date du jour locale (YYYY-MM-DD) — même convention que l'écran Clôture. */
function todayLocal(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** « mai 2026 » depuis une clé AAAA-MM. */
function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** bps signés → « +12,3 » / « −8,1 » (le % est porté par le libellé). */
function pctFromBps(bps: number): string {
  const abs = (Math.abs(bps) / 100).toFixed(1).replace('.', ',');
  return `${bps >= 0 ? '+' : '−'}${abs}`;
}

export default function Pilotage() {
  const { personality, colors, semantic } = useTheme();
  const insets = useSafeAreaInsets();
  const bobScrollInsets = useBobAwareScrollInsets({ minimumBottom: insets.bottom + 34 });
  const router = useRouter();
  // Entitlement TYPÉ (fondation paywall) — même feature que le gating historique de l'écran.
  const entitlement = useEntitlement('accounting_operations');
  const entries = useAccountingEntries();
  const payments = usePayments();
  const invoices = useInvoices();
  const customers = useCustomers();
  const expenses = useExpenses();
  const company = useCompany();
  const entitled = entitlement.allowed;

  // P1 (audit 14/07) : failed se lit TOUJOURS avec loading — ne jamais confondre un échec
  // réseau avec une absence de données (le pilotage prendrait alors l'air d'un cabinet vide).
  const queryState = combineQueryStates(entries, payments, invoices, customers, expenses, company);
  // Pending VISIBLE du « Réessayer » — l'utilisateur voit que ça travaille (passe feel 18/07).
  const reviewRefetching =
    entries.isRefetching ||
    payments.isRefetching ||
    invoices.isRefetching ||
    customers.isRefetching ||
    expenses.isRefetching ||
    company.isRefetching;

  // Une seule vérité : le MÊME use case pur que Bob (getBusinessReview) — parité garantie.
  const review: BusinessReview | null = useMemo(() => {
    // Une query manquante n'est pas un zéro. On ne construit donc aucun agrégat — même
    // temporaire et invisible — si une source a échoué. Cela empêche aussi le contexte vocal
    // de publier un classement calculé sur un sous-ensemble de données.
    if (
      queryState.loading ||
      queryState.failed ||
      entries.data === undefined ||
      payments.data === undefined ||
      invoices.data === undefined ||
      customers.data === undefined ||
      expenses.data === undefined ||
      company.data === undefined
    ) return null;
    return deriveBusinessReview({
      entries: entries.data.map((e) => ({ entryDate: e.entryDate, sourceType: e.sourceType, lines: e.lines })),
      payments: payments.data.map((p) => ({ amountCents: p.amountCents, receivedAt: p.receivedAt })),
      invoices: invoices.data.map((i) => ({
        kind: i.kind,
        status: i.status,
        totals: i.totals,
        paid: i.paid,
        dueAt: i.dueAt,
        customerId: i.customerId,
        // PR-07 : identité + faits de transmission (PR-02) — la carte Encaissement dérive
        // « émises sans envoi constaté » de la MÊME vérité que le badge de liste (fail-closed
        // si un serveur antérieur ne transporte pas les faits).
        id: i.id,
        number: i.number,
        ...(i.emailDeliveredAt !== undefined ? { emailDeliveredAt: i.emailDeliveredAt } : {}),
        ...(i.transmission !== undefined ? { transmission: i.transmission } : {}),
      })),
      customers: customers.data.map((c) => ({ id: c.id, name: c.name })),
      expenses: expenses.data.map((e) => ({
        category: e.category,
        totalTtcCents: e.totalTtcCents,
        vatCents: e.vatCents,
        documentDate: e.documentDate,
        status: e.status,
      })),
      vatRegime: company.data.vatRegime ?? null,
      today: todayLocal(),
    });
  }, [
    queryState.failed,
    queryState.loading,
    entries.data,
    payments.data,
    invoices.data,
    customers.data,
    expenses.data,
    company.data,
  ]);

  const agentDataReady =
    entitlement.verified &&
    entitled &&
    !queryState.loading &&
    !queryState.failed &&
    review !== null;

  // Bob voit les top clients AFFICHÉS : « parle-moi de ce client », « résume l'écran ».
  // Le paywall est une frontière de visibilité : aucune entité ni capability client ne fuit
  // tant que l'offre ne rend pas réellement le pilotage à l'écran.
  const agentContext = useMemo<AgentContext>(
    () => ({
      screen: { name: 'pilotage', instanceId: 'pilotage' },
      entities: agentDataReady && review !== null
        ? review.topClients.lines.slice(0, 5).map((line) => ({
            type: 'customer' as const,
            id: line.customerId,
            label: line.customerName,
          }))
        : [],
      capabilities: agentDataReady ? ['screen.read', 'customer.read'] : [],
    }),
    [agentDataReady, review],
  );
  usePublishAgentContext(agentContext);

  const section = (title: I18nKey, body: ReactNode, hint?: I18nKey): ReactNode => (
    <View>
      <SectionHeader title={t(title, { personality })} />
      {body}
      {hint ? (
        <Text style={[font('meta'), { color: colors.slate400, marginTop: 6, lineHeight: 16 }]}>{t(hint, { personality })}</Text>
      ) : null}
    </View>
  );

  /** Ligne « libellé …… montant » (+ % du CA optionnel) pour la cascade SIG. */
  function SigRow({ label, cents, bpsOfCa, strong, topBorder }: { label: string; cents: number; bpsOfCa?: number | null; strong?: boolean; topBorder?: boolean }) {
    return (
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
          paddingVertical: strong ? 8 : 6,
          borderTopWidth: topBorder ? 1 : 0,
          borderTopColor: colors.lineSoft,
        }}
      >
        <Text style={[strong ? font('cardTitle') : font('sub'), { color: colors.ink800, flexShrink: 1 }]}>{label}</Text>
        <View style={{ alignItems: 'flex-end' }}>
          <Text
            style={[
              strong ? font('cardTitle') : font('sub'),
              {
                // Agrégats clés (CA/VA/EBE/Résultat) : succès/danger — les autres lignes
                // (charges, impôts…) restent en ton neutre/warning discret.
                color: strong
                  ? cents >= 0
                    ? semantic.success
                    : semantic.danger
                  : cents >= 0
                    ? colors.ink900
                    : semantic.warning,
                fontVariant: ['tabular-nums'],
              },
            ]}
          >
            {cents < 0 ? '−' : ''}
            {formatEUR(Math.abs(cents))}
          </Text>
          {bpsOfCa !== undefined && bpsOfCa !== null ? (
            <Text style={[font('meta'), { color: colors.slate400 }]}>
              {t('pilotage.ratioOfCa', { personality, params: { pct: (bpsOfCa / 100).toFixed(1).replace('.', ',') } })}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }

  /** Barres mensuelles (facturé/encaissé) — View pures, normalisées au max de la fenêtre. */
  function SeriesBars({ data, currentMonth }: { data: BusinessReview['series']; currentMonth: string }) {
    const window = data.slice(-6);
    const max = Math.max(1, ...window.map((p) => Math.max(p.invoicedHtCents, p.collectedTtcCents)));
    return (
      <Card>
        {window.map((point, index) => {
          const isCurrent = point.month === currentMonth;
          return (
            <View
              key={point.month}
              accessible
              accessibilityLabel={`${monthLabel(point.month)}. ${t('pilotage.invoicedLabel', { personality })} ${formatEUR(point.invoicedHtCents)}. ${t('pilotage.collectedLabel', { personality })} ${formatEUR(point.collectedTtcCents)}.`}
              style={{ marginTop: index === 0 ? 0 : 10 }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={[isCurrent ? font('meta', 700) : font('meta'), { color: isCurrent ? colors.ink900 : colors.slate500 }]}>
                  {monthLabel(point.month)}
                </Text>
                <Text style={{ ...font('meta'), color: colors.slate400, fontVariant: ['tabular-nums'] }}>
                  {formatEUR(point.invoicedHtCents)} · {formatEUR(point.collectedTtcCents)}
                </Text>
              </View>
              {/* Facturé (ink600) / encaissé (success) — TrendBars kit : barres qui poussent
                  400 ms ease-out, statiques dès la première frame tant que la préférence
                  motion n'est pas résolue (fail-closed par construction, Lot 5). */}
              <TrendBars
                bars={[
                  {
                    pct: Math.round((Math.max(0, point.invoicedHtCents) / max) * 100),
                    color: colors.ink600,
                  },
                  {
                    pct: Math.round((Math.max(0, point.collectedTtcCents) / max) * 100),
                    color: semantic.success,
                  },
                ]}
              />
            </View>
          );
        })}
        <View style={{ flexDirection: 'row', gap: 14, marginTop: 12 }}>
          {(
            [
              { color: colors.ink600, label: t('pilotage.invoicedLabel', { personality }) },
              { color: semantic.success, label: t('pilotage.collectedLabel', { personality }) },
            ] as const
          ).map((legend) => (
            <View key={legend.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: legend.color }} />
              <Text style={[font('meta'), { color: colors.slate400 }]}>{legend.label}</Text>
            </View>
          ))}
        </View>
      </Card>
    );
  }

  /** Part client colorée selon le risque de concentration — cohérent avec l'alerte existante. */
  function shareRiskColor(shareBps: number | null): string {
    if (shareBps === null) return colors.slate400;
    if (shareBps >= 5000) return semantic.danger;
    // Même seuil que deriveBusinessReview (30 %) : l'alerte texte et la couleur ne divergent pas.
    if (shareBps >= 3000) return semantic.warning;
    return colors.slate500;
  }

  /** Rangée de classement (top clients / top dépenses). progressPct/progressColor : barre de
   * proportion optionnelle (utilisée pour la part des top clients, cohérente avec metaColor). */
  function RankRow({
    label,
    amountCents,
    meta,
    metaColor,
    divider,
    warn,
    progressPct,
    progressColor,
  }: {
    label: string;
    amountCents: number;
    meta?: string | null;
    metaColor?: string;
    divider: boolean;
    warn?: boolean;
    progressPct?: number | null;
    progressColor?: string;
  }) {
    return (
      <View
        accessible
        accessibilityLabel={`${label}. ${formatEUR(amountCents)}${meta ? `. ${meta}` : ''}`}
        style={{
          paddingVertical: 10,
          borderBottomWidth: divider ? 1 : 0,
          borderBottomColor: colors.lineSoft,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Text style={[font('sub'), { color: warn ? semantic.warning : colors.ink800, flex: 1 }]} numberOfLines={1}>
            {label}
          </Text>
          {meta ? (
            <Text style={[metaColor ? font('meta', 700) : font('meta'), { color: metaColor ?? colors.slate400 }]}>{meta}</Text>
          ) : null}
          <Text
            style={{
              ...font('sub', 700),
              color: amountCents >= 0 ? colors.ink900 : semantic.warning,
              fontVariant: ['tabular-nums'],
            }}
          >
            {amountCents < 0 ? '−' : ''}
            {formatEUR(Math.abs(amountCents))}
          </Text>
        </View>
        {progressPct !== null && progressPct !== undefined ? (
          // Part de classement — même primitive TrendBars (le clamp [0,100] vit au kit).
          <TrendBars
            bars={[{ pct: progressPct, color: progressColor ?? colors.slate400 }]}
            height={4}
            radius={2}
            style={{ marginTop: 6 }}
          />
        ) : null}
      </View>
    );
  }

  const body = (r: BusinessReview): ReactNode => {
    if (r.coverage.firstMonth === null) {
      return (
        <Card>
          <EmptyState body={t('pilotage.empty', { personality })} />
        </Card>
      );
    }
    const cur = r.currentMonth;
    const trend = r.lastClosedComparison;
    return (
      // Cascade sobre : chaque carte du bilan fond en entrant (40 ms/rang, cap 8) —
      // les wrappers FadeIn restent des enfants directs du conteneur gap:14 (zéro saut).
      <StaggeredList>
        {/* Mois en cours — HÉROS MATIÈRE (Lot 5, planche « matière argent ») : recette
            HeroMoneyCard (radius 24, padding 20, ombre heroMoney) sur la matière verte
            monthReady ; l'ENCAISSÉ est le chiffre-héros (MoneyText moneyHero 27/800,
            success), le facturé passe second. Isopérimètre, jamais de % plein-mois. */}
        {section(
          'pilotage.sectionMonth',
          <View style={[{ borderRadius: 24 }, shadowComponentsNative.heroMoney]}>
            <LinearGradient
              colors={[vault.monthReadyTop, vault.monthReadyBottom]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={{
                borderRadius: 24,
                borderWidth: 1,
                borderColor: vault.monthReadyBorder,
                padding: 20,
              }}
            >
              {/* Encaissé : la bonne nouvelle du mois — le héros. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: semantic.success }} />
                <Text style={[font('meta'), { color: colors.slate400 }]}>{t('pilotage.collectedLabel', { personality })}</Text>
              </View>
              <View style={{ marginTop: 2 }}>
                <MoneyText cents={cur.collectedTtcCents} variant="moneyHero" color={semantic.success} />
              </View>
              <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{t('pilotage.collectedHint', { personality })}</Text>
              <View style={{ height: 1, backgroundColor: vault.monthReadyBorder, marginVertical: 10 }} />
              {/* Facturé : montant neutre (ink900) + delta isopérimètre. */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colors.ink600 }} />
                    <Text style={[font('meta'), { color: colors.slate400 }]}>
                      {t('pilotage.invoicedLabel', { personality })} · {t('pilotage.atDay', { personality, params: { day: String(cur.atDay) } })}
                    </Text>
                  </View>
                  <View style={{ marginTop: 2 }}>
                    <MoneyText cents={cur.invoicedHtCents} variant="big" />
                  </View>
                  <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>{t('pilotage.invoicedHint', { personality })}</Text>
                </View>
                {cur.invoicedDeltaBps !== null ? (
                  <StatusBadge label={`${pctFromBps(cur.invoicedDeltaBps)} %`} variant={cur.invoicedDeltaBps >= 0 ? 'success' : 'danger'} />
                ) : null}
              </View>
              {cur.invoicedDeltaBps !== null ? (
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 4 }]}>{t('pilotage.isoCompare', { personality })}</Text>
              ) : null}
            </LinearGradient>
          </View>,
        )}

        {/* Tendance — mois clos + cumul annuel gated par la couverture */}
        {section(
          'pilotage.sectionTrend',
          <Card>
            {trend ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[font('sub'), { color: colors.ink800 }]}>
                    {t('pilotage.trendMonths', {
                      personality,
                      params: { month: monthLabel(trend.month), prev: monthLabel(trend.previousMonth) },
                    })}
                  </Text>
                  {/* Fond très léger selon le signe (successBg/warningBg) + flèche préfixe. */}
                  <View
                    style={{
                      alignSelf: 'flex-start',
                      marginTop: 2,
                      backgroundColor: trend.deltaCents >= 0 ? semantic.successBg : semantic.warningBg,
                      borderRadius: 8,
                      paddingHorizontal: 8,
                      paddingVertical: 3,
                    }}
                  >
                    <Text style={{ ...font('cardTitle'), color: trend.deltaCents >= 0 ? semantic.success : semantic.warning, fontVariant: ['tabular-nums'] }}>
                      {trend.deltaCents >= 0 ? '▲ +' : '▼ −'}
                      {formatEUR(Math.abs(trend.deltaCents))}
                    </Text>
                  </View>
                </View>
                {trend.deltaBps !== null ? (
                  <StatusBadge label={`${pctFromBps(trend.deltaBps)} %`} variant={trend.deltaBps >= 0 ? 'success' : 'danger'} />
                ) : (
                  <Text style={[font('sub'), { color: colors.slate400 }]}>—</Text>
                )}
              </View>
            ) : (
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>{t('pilotage.trendTooEarly', { personality })}</Text>
            )}
            {r.ytd ? (
              <>
                <View style={{ height: 1, backgroundColor: colors.lineSoft, marginVertical: 10 }} />
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[font('sub'), { color: colors.ink800 }]}>{t('pilotage.ytdLabel', { personality })}</Text>
                    <Text style={{ ...font('cardTitle'), color: colors.ink900, marginTop: 2, fontVariant: ['tabular-nums'] }}>
                      {formatEUR(r.ytd.invoicedHtCents)}
                    </Text>
                    <Text style={[font('meta'), { color: colors.slate400, marginTop: 2 }]}>
                      {t('pilotage.ytdPrev', { personality, params: { amount: formatEUR(r.ytd.previousYearInvoicedHtCents) } })}
                    </Text>
                  </View>
                  {r.ytd.deltaBps !== null ? (
                    <StatusBadge label={`${pctFromBps(r.ytd.deltaBps)} %`} variant={r.ytd.deltaBps >= 0 ? 'success' : 'danger'} />
                  ) : null}
                </View>
              </>
            ) : null}
          </Card>,
        )}

        {/* Série mensuelle */}
        {r.series.length >= 2 ? section('pilotage.sectionSeries', <SeriesBars data={r.series} currentMonth={r.currentMonth.month} />) : null}

        {/* DSO */}
        {section(
          'pilotage.sectionDso',
          <Card>
            {r.dso.days === null ? (
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                {t(r.dso.reason === 'insufficient_history' ? 'pilotage.dsoNoHistory' : 'pilotage.dsoNoInvoicing', { personality })}
              </Text>
            ) : r.dso.days === 0 ? (
              <Text style={[font('sub'), { color: semantic.success, lineHeight: 19 }]}>{t('pilotage.dsoAllCollected', { personality })}</Text>
            ) : (
              <>
                {/* Chiffre-héros de la carte — cran moneyHero (27/800, Lot 0), fin du 26 ad hoc. */}
                <Text style={{ ...font('moneyHero'), color: colors.ink900, fontVariant: ['tabular-nums'] }}>
                  {t('pilotage.dsoDays', { personality, params: { days: String(r.dso.days) } })}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 3, lineHeight: 17 }]}>{t('pilotage.dsoHint', { personality })}</Text>
                <Text style={[font('sub'), { color: colors.ink800, marginTop: 8 }]}>
                  {t('pilotage.dsoLocked', { personality, params: { amount: formatEUR(r.dso.receivablesCents) } })}
                </Text>
              </>
            )}
          </Card>,
        )}

        {/* PR-07 — Encaissement : % encaissé 90 j (honnêteté DSO), encours échu, émises sans
            envoi constaté avec CTA vers la fiche (où vivent envoi email + guide de dépôt). */}
        {section(
          'pilotage.sectionCollection',
          <Card>
            {r.collection.collectedRateBps90d === null ? (
              <Text style={[font('sub'), { color: colors.slate500, lineHeight: 19 }]}>
                {t(
                  r.collection.reason === 'insufficient_history'
                    ? 'pilotage.collectionNoHistory'
                    : 'pilotage.collectionNoInvoicing',
                  { personality },
                )}
              </Text>
            ) : (
              <>
                <Text style={{ ...font('moneyHero'), color: r.collection.collectedRateBps90d >= 8_000 ? semantic.success : r.collection.collectedRateBps90d >= 5_000 ? semantic.warning : semantic.danger, fontVariant: ['tabular-nums'] }}>
                  {t('pilotage.collectionRate', {
                    personality,
                    params: { pct: String(Math.round(r.collection.collectedRateBps90d / 100)) },
                  })}
                </Text>
                <Text style={[font('meta'), { color: colors.slate400, marginTop: 3, lineHeight: 17 }]}>
                  {t('pilotage.collectionRateHint', {
                    personality,
                    params: {
                      collected: formatEUR(r.collection.collectedTtc90dCents),
                      invoiced: formatEUR(r.collection.invoicedTtc90dCents),
                    },
                  })}
                </Text>
              </>
            )}
            {r.collection.overdueCents > 0 ? (
              <Text style={[font('sub'), { color: colors.ink800, marginTop: 8 }]}>
                {t('pilotage.collectionOverdue', {
                  personality,
                  params: { amount: formatEUR(r.collection.overdueCents) },
                })}
              </Text>
            ) : null}
            {r.collection.untransmitted.length > 0 ? (
              <View style={{ marginTop: 12, gap: 4 }}>
                <Text style={[font('label', 700), { fontSize: 12, color: semantic.warning }]}>
                  {t('pilotage.collectionUntransmittedTitle', {
                    personality,
                    params: { count: r.collection.untransmitted.length },
                  }).toUpperCase()}
                </Text>
                {r.collection.untransmitted.slice(0, 5).map((line, index) => (
                  <Pressable
                    key={line.invoiceId}
                    accessibilityRole="button"
                    accessibilityLabel={`${line.docNumber ?? line.invoiceId} — ${line.customerName}`}
                    onPress={() => router.push(`/facture/${line.invoiceId}`)}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      minHeight: 40,
                      opacity: pressed ? 0.65 : 1,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: colors.lineSoft,
                    })}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[font('sub', 600), { fontSize: 13.5, color: colors.ink800 }]} numberOfLines={1}>
                        {line.docNumber ?? line.invoiceId} · {line.customerName}
                      </Text>
                    </View>
                    <Text style={[font('sub', 700), { color: semantic.warning, fontVariant: ['tabular-nums'] }]}>
                      {formatEUR(line.amountCents)}
                    </Text>
                    <ChevronRightIcon color={colors.slate300} size={14} />
                  </Pressable>
                ))}
              </View>
            ) : null}
          </Card>,
          'pilotage.collectionNote',
        )}

        {/* Top clients */}
        {section(
          'pilotage.sectionTopClients',
          <Card>
            {r.topClients.lines.length === 0 ? (
              <EmptyState body={t('pilotage.noClients', { personality })} />
            ) : (
              <>
                {r.topClients.lines.map((line, index) => (
                  <RankRow
                    key={line.customerId}
                    label={`${index + 1}. ${line.customerName}`}
                    amountCents={line.invoicedTtc12mCents}
                    meta={line.shareBps !== null ? `${Math.round(line.shareBps / 100)} %` : null}
                    metaColor={shareRiskColor(line.shareBps)}
                    progressPct={line.shareBps !== null ? line.shareBps / 100 : null}
                    progressColor={shareRiskColor(line.shareBps)}
                    divider={index < r.topClients.lines.length - 1 || r.topClients.othersCount > 0 || r.topClients.creditNetCount > 0}
                  />
                ))}
                {r.topClients.othersCount > 0 ? (
                  <RankRow
                    label={t('pilotage.othersClients', { personality, params: { count: String(r.topClients.othersCount) } })}
                    amountCents={r.topClients.othersCents}
                    divider={r.topClients.creditNetCount > 0}
                  />
                ) : null}
                {r.topClients.creditNetCount > 0 ? (
                  <RankRow
                    label={t('pilotage.creditNet', { personality, params: { count: String(r.topClients.creditNetCount) } })}
                    amountCents={r.topClients.creditNetCents}
                    divider={false}
                  />
                ) : null}
                {r.topClients.concentrationAlert && r.topClients.lines[0] && r.topClients.top1ShareBps !== null ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.lineSoft }}>
                    {/* « Risque » textuel (Lot 5) : annoncé par VoiceOver, warning = l'actionnable —
                        un « ! » en ton particulier ne disait ni le risque ni à qui. */}
                    <StatusBadge label={t('pilotage.concentrationBadge', { personality })} variant="warning" />
                    <Text style={[font('meta'), { color: colors.slate500, flex: 1, lineHeight: 17 }]}>
                      {t('pilotage.concentration', {
                        personality,
                        params: {
                          name: r.topClients.lines[0].customerName,
                          share: String(Math.round(r.topClients.top1ShareBps / 100)),
                        },
                      })}
                    </Text>
                  </View>
                ) : null}
              </>
            )}
          </Card>,
          'pilotage.topClientsHint',
        )}

        {/* Top dépenses */}
        {section(
          'pilotage.sectionTopExpenses',
          <Card>
            {r.topExpenses.lines.length === 0 ? (
              <EmptyState body={t('pilotage.noExpenses', { personality })} />
            ) : (
              r.topExpenses.lines.map((line, index) => (
                <RankRow
                  key={line.category}
                  label={t(CAT_KEY[line.category], { personality })}
                  amountCents={line.chargeCents}
                  meta={line.deltaBps !== null ? `${pctFromBps(line.deltaBps)} %` : null}
                  divider={index < r.topExpenses.lines.length - 1}
                />
              ))
            )}
          </Card>,
          'pilotage.topExpensesHint',
        )}

        {/* Cascade SIG + ratios */}
        {section(
          'pilotage.sectionSig',
          <Card>
            <SigRow label={t('pilotage.sigCa', { personality })} cents={r.ratios.caCents} strong />
            {r.sig.margeCommercialeActive ? (
              <SigRow label={t('pilotage.sigMarge', { personality })} cents={r.sig.margeCommercialeCents} bpsOfCa={r.ratios.margeMateriauxBps} />
            ) : null}
            <SigRow label={t('pilotage.sigConso', { personality })} cents={-r.sig.consommationsCents} bpsOfCa={r.ratios.chargesExternesBps} />
            <SigRow label={t('pilotage.sigVa', { personality })} cents={r.sig.valeurAjouteeCents} strong topBorder />
            {r.sig.impotsTaxesCents !== 0 ? <SigRow label={t('pilotage.sigImpots', { personality })} cents={-r.sig.impotsTaxesCents} /> : null}
            {r.sig.chargesPersonnelCents !== 0 ? (
              <SigRow label={t('pilotage.sigPersonnel', { personality })} cents={-r.sig.chargesPersonnelCents} bpsOfCa={r.ratios.personnelVaBps} />
            ) : null}
            <SigRow label={t('pilotage.sigEbe', { personality })} cents={r.sig.ebeCents} bpsOfCa={r.ratios.ebeBps} strong topBorder />
            <Text style={[font('meta'), { color: colors.slate400, marginTop: 2, lineHeight: 16 }]}>{t('pilotage.sigEbeHint', { personality })}</Text>
            <SigRow label={t('pilotage.sigRex', { personality })} cents={r.sig.resultatExploitationCents} bpsOfCa={r.ratios.rexBps} strong topBorder />
            <Text style={[font('meta'), { color: colors.slate400, marginTop: 8 }]}>{t('pilotage.sigPeriod', { personality })}</Text>
          </Card>,
        )}

        <Text style={[font('meta'), { color: colors.slate400, textAlign: 'center' }]}>
          {t('pilotage.coverage', { personality, params: { month: monthLabel(r.coverage.firstMonth) } })}
        </Text>
      </StaggeredList>
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
        {/* Rangée retour kit (Lot 5) : cible 44 pt (était 34 ad hoc) + voile de dissolution —
            le MÊME mécanisme HeaderVeil que les headers, fail-closed par construction. */}
        <StickyBackRow
          backLabel={t('pilotage.back', { personality })}
          onBack={() => router.back()}
          veil
        />

        <InnerScreenHeader
          eyebrow={t('pilotage.eyebrow', { personality })}
          title={t('pilotage.title', { personality })}
          subtitle={t('pilotage.subtitle', { personality })}
        />

        <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 14 }}>
          {/* Abonnement ou données en chargement → squelettes, JAMAIS le paywall ;
              l'échec données est prioritaire sur `review === null` pour garantir le retry ;
              verrouillé → carte contextuelle du domaine (même emplacement que le contenu) ;
              decision 'unavailable' (aucun catalogue ne vend la capacité) → PaywallCard rend
              null PAR CONSTRUCTION (paywall.tsx) : repli EmptyState pour ne jamais laisser
              l'écran vide (P2 audit 14/07). */}
          {entitlement.loading ? (
            // 6 Cards réelles (mois en cours, tendance, DSO, top clients, top dépenses,
            // cascade SIG) — hauteurs calées sur leur gabarit final (zéro saut de layout).
            // La série mensuelle (conditionnelle, ≥2 mois d'historique) n'est pas squelettée.
            <>
              <SkeletonCard height={150} contentLines={4} />
              <SkeletonCard height={140} contentLines={4} />
              <SkeletonCard height={104} contentLines={3} />
              <SkeletonCard height={260} contentLines={5} />
              <SkeletonCard height={220} contentLines={5} />
              <SkeletonCard height={230} contentLines={5} />
            </>
          ) : !entitled ? (
            entitlement.decision !== null ? (
              entitlement.decision.kind === 'unavailable' ? (
                <Card>
                  <EmptyState
                    title={t('pilotage.paywallTitle', { personality })}
                    body={t('pilotage.paywallBody', { personality })}
                  />
                </Card>
              ) : (
                <PaywallCard
                  decision={entitlement.decision}
                  source="feature_screen"
                  personality={personality}
                  onDismissed={() => router.back()}
                />
              )
            ) : null
          ) : queryState.failed ? (
            // P1 (audit 14/07) : un échec réseau n'est JAMAIS confondu avec une absence de
            // données — vérifié AVANT le calcul/rendu de review (jamais un « rien à afficher »
            // qui masquerait le fait que le fetch a raté).
            <ErrorRetry
              message={t('today.dataError', { personality })}
              onRetry={queryState.refetchAll}
              retrying={reviewRefetching}
            />
          ) : queryState.loading || review === null ? (
            // L'échec est testé AVANT `review === null` : sinon un premier chargement en
            // erreur laisse `review` nul et affiche un skeleton éternel au lieu du retry.
            <>
              <SkeletonCard height={150} contentLines={4} />
              <SkeletonCard height={140} contentLines={4} />
              <SkeletonCard height={104} contentLines={3} />
              <SkeletonCard height={260} contentLines={5} />
              <SkeletonCard height={220} contentLines={5} />
              <SkeletonCard height={230} contentLines={5} />
            </>
          ) : review !== null ? (
            body(review)
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
